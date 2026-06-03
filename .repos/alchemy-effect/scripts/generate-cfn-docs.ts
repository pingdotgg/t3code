import fs from "node:fs/promises";
import path from "node:path";

const CONCURRENCY = 10;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

let failedRequests = 0;

const CFN_SPEC_URL =
  "https://d1uauaxba7bl26.cloudfront.net/latest/gzip/CloudFormationResourceSpecification.json";

interface Property {
  Documentation?: string;
  UpdateType?: "Mutable" | "Immutable" | "Conditional";
  Required?: boolean;
  Type?: string;
  PrimitiveType?: string;
  ItemType?: string;
  PrimitiveItemType?: string;
  DuplicatesAllowed?: boolean;
}

interface Attribute {
  Type?: string;
  PrimitiveType?: string;
  ItemType?: string;
  PrimitiveItemType?: string;
}

interface ResourceType {
  Documentation?: string;
  Properties?: Record<string, Property>;
  Attributes?: Record<string, Attribute>;
}

interface PropertyType {
  Documentation?: string;
  Properties?: Record<string, Property>;
}

interface CFNSpec {
  ResourceSpecificationVersion: string;
  ResourceTypes: Record<string, ResourceType>;
  PropertyTypes: Record<string, PropertyType>;
}

// Scraped data from HTML
interface ScrapedResourceData {
  description: string;
  propertyDescriptions: Map<string, PropertyDescription>;
  returnValues: ReturnValueInfo[];
  examples: Example[];
}

interface PropertyDescription {
  description: string;
  allowedValues?: string[];
}

interface ReturnValueInfo {
  name: string;
  description: string;
  example?: string;
}

interface Example {
  title: string;
  description: string;
  json?: string;
  yaml?: string;
}

// Parse AWS::Service::Resource into { service, resource }
function parseResourceType(
  type: string,
): { service: string; resource: string } | null {
  const parts = type.split("::");
  if (parts.length !== 3 || parts[0] !== "AWS") return null;
  return { service: parts[1], resource: parts[2] };
}

// Parse AWS::Service::Resource.PropertyType into { service, resource, propertyType }
function parsePropertyType(
  type: string,
): { service: string; resource: string; propertyType: string } | null {
  const match = type.match(/^AWS::([^:]+)::([^.]+)\.(.+)$/);
  if (!match) return null;
  return { service: match[1], resource: match[2], propertyType: match[3] };
}

// Convert service name to lowercase kebab-case for directory naming
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

// Format a property type for display (no links, just type names for LLM consumption)
function formatType(prop: Property | Attribute): string {
  if (prop.PrimitiveType) {
    return prop.PrimitiveType;
  }
  if (prop.Type === "List") {
    if (prop.PrimitiveItemType) {
      return `List<${prop.PrimitiveItemType}>`;
    }
    if (prop.ItemType) {
      return `List<${prop.ItemType}>`;
    }
    return "List";
  }
  if (prop.Type === "Map") {
    if (prop.PrimitiveItemType) {
      return `Map<String, ${prop.PrimitiveItemType}>`;
    }
    if (prop.ItemType) {
      return `Map<String, ${prop.ItemType}>`;
    }
    return "Map";
  }
  if (prop.Type) {
    return prop.Type;
  }
  return "Unknown";
}

// Strip HTML tags and decode entities
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Convert HTML to simple markdown
function htmlToMarkdown(html: string): string {
  return (
    html
      .replace(/<code class="code">([^<]+)<\/code>/g, "`$1`")
      .replace(/<em>([^<]+)<\/em>/g, "*$1*")
      .replace(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g, "[$2]($1)")
      .replace(/<p>/g, "")
      .replace(/<\/p>/g, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      // Normalize whitespace: collapse multiple spaces/tabs and trim each line
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .join("\n")
      // Collapse multiple newlines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// Concurrency limiter
function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    while (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

// Delay helper
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch with retry and exponential backoff
async function fetchWithRetry(
  url: string,
  retries = MAX_RETRIES,
): Promise<Response | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
      });

      if (res.ok) {
        return res;
      }

      // Don't retry on 404 - page doesn't exist
      if (res.status === 404) {
        console.error(`  404 Not Found: ${url}`);
        failedRequests++;
        return null;
      }

      // Retry on rate limiting or server errors
      if (res.status === 429 || res.status >= 500) {
        const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(
          `  ${res.status} on ${url} - retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries + 1})`,
        );
        await delay(backoffMs);
        continue;
      }

      // Other errors - log and don't retry
      console.error(`  HTTP ${res.status} ${res.statusText}: ${url}`);
      failedRequests++;
      return null;
    } catch (error) {
      const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.warn(
        `  Network error on ${url} - retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries + 1}): ${error}`,
      );
      await delay(backoffMs);
    }
  }

  console.error(`  Failed after ${retries + 1} attempts: ${url}`);
  failedRequests++;
  return null;
}

// Scraped data for a property type (struct)
interface ScrapedPropertyTypeData {
  description: string;
  propertyDescriptions: Map<string, PropertyDescription>;
}

// Scrape property type documentation from AWS HTML
async function scrapePropertyTypeDocs(
  docUrl: string,
): Promise<ScrapedPropertyTypeData | null> {
  const res = await fetchWithRetry(docUrl);
  if (!res) return null;

  try {
    const html = await res.text();

    const result: ScrapedPropertyTypeData = {
      description: "",
      propertyDescriptions: new Map(),
    };

    // Extract description - paragraphs after the h1 until the first h2
    const descMatch = html.match(
      /<\/awsdocs-filter-selector><\/div>([\s\S]*?)<h2/,
    );
    if (descMatch) {
      const paragraphs = descMatch[1].match(/<p>[\s\S]*?<\/p>/g) || [];
      result.description = paragraphs
        .map((p) => htmlToMarkdown(p))
        .filter((p) => p.length > 0)
        .join("\n\n");
    }

    // Extract property descriptions from the variablelist
    const propsMatch = html.match(
      /<h2 id="[^"]*-properties"[^>]*>Properties<\/h2>([\s\S]*?)(?:<h2|$)/,
    );
    if (propsMatch) {
      const propsHtml = propsMatch[1];
      const propRegex =
        /<dt id="([^"]+)"[^>]*>[\s\S]*?<code class="code">([^<]+)<\/code>[\s\S]*?<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g;
      let match;
      while ((match = propRegex.exec(propsHtml)) !== null) {
        const propName = match[2];
        const propContent = match[3];

        const descParts = propContent.split(/<p><em>Required<\/em>/);
        let description = "";
        if (descParts[0]) {
          description = htmlToMarkdown(descParts[0]);
        }

        let allowedValues: string[] | undefined;
        const allowedMatch = propContent.match(
          /<em>Allowed values<\/em>:\s*<code class="code">([^<]+)<\/code>/,
        );
        if (allowedMatch) {
          allowedValues = allowedMatch[1].split(" | ").map((v) => v.trim());
        }

        if (propName) {
          result.propertyDescriptions.set(propName, {
            description,
            allowedValues,
          });
        }
      }
    }

    return result;
  } catch (error) {
    console.error(`  Error parsing ${docUrl}:`, error);
    failedRequests++;
    return null;
  }
}

// Scrape resource documentation from AWS HTML
async function scrapeResourceDocs(
  docUrl: string,
): Promise<ScrapedResourceData | null> {
  const res = await fetchWithRetry(docUrl);
  if (!res) return null;

  try {
    const html = await res.text();

    const result: ScrapedResourceData = {
      description: "",
      propertyDescriptions: new Map(),
      returnValues: [],
      examples: [],
    };

    // Extract description - paragraphs after the h1 until the first h2
    const descMatch = html.match(
      /<\/awsdocs-filter-selector><\/div>([\s\S]*?)<h2/,
    );
    if (descMatch) {
      // Extract just the text content from paragraphs
      const paragraphs = descMatch[1].match(/<p>[\s\S]*?<\/p>/g) || [];
      result.description = paragraphs
        .map((p) => htmlToMarkdown(p))
        .filter((p) => p.length > 0)
        .join("\n\n");
    }

    // Extract property descriptions from the variablelist
    const propsMatch = html.match(
      /<h2 id="[^"]*-properties"[^>]*>Properties<\/h2>([\s\S]*?)(?:<h2|$)/,
    );
    if (propsMatch) {
      const propsHtml = propsMatch[1];
      // Match each property definition
      const propRegex =
        /<dt id="([^"]+)"[^>]*>[\s\S]*?<code class="code">([^<]+)<\/code>[\s\S]*?<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g;
      let match;
      while ((match = propRegex.exec(propsHtml)) !== null) {
        const propName = match[2];
        const propContent = match[3];

        // Extract the description (first paragraph or text before Required)
        const descParts = propContent.split(/<p><em>Required<\/em>/);
        let description = "";
        if (descParts[0]) {
          description = htmlToMarkdown(descParts[0]);
        }

        // Extract allowed values if present
        let allowedValues: string[] | undefined;
        const allowedMatch = propContent.match(
          /<em>Allowed values<\/em>:\s*<code class="code">([^<]+)<\/code>/,
        );
        if (allowedMatch) {
          allowedValues = allowedMatch[1].split(" | ").map((v) => v.trim());
        }

        if (propName && description) {
          result.propertyDescriptions.set(propName, {
            description,
            allowedValues,
          });
        }
      }
    }

    // Extract return values
    const returnMatch = html.match(
      /<h2 id="[^"]*-return-values"[^>]*>Return values<\/h2>([\s\S]*?)(?:<h2 id="[^"]*-examples"|<h2 id="[^"]*-seealso"|<awsdocs-copyright|$)/,
    );
    if (returnMatch) {
      const returnHtml = returnMatch[1];

      // Match Fn::GetAtt values
      const attrRegex =
        /<dt id="([^"]+)-fn::getatt"[^>]*>[\s\S]*?<code class="code">([^<]+)<\/code>[\s\S]*?<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g;
      let match;
      while ((match = attrRegex.exec(returnHtml)) !== null) {
        const attrName = match[2];
        const attrContent = match[3];

        // Extract description
        const descMatch = attrContent.match(/<p>([\s\S]*?)<\/p>/);
        let description = descMatch ? htmlToMarkdown(descMatch[1]) : "";

        // Extract example if present
        let example: string | undefined;
        const exampleMatch = attrContent.match(
          /Example:\s*<code class="code">([^<]+)<\/code>/,
        );
        if (exampleMatch) {
          example = exampleMatch[1].trim();
        }

        result.returnValues.push({ name: attrName, description, example });
      }
    }

    // Extract examples
    const examplesMatch = html.match(
      /<h2 id="[^"]*-examples"[^>]*>Examples<\/h2>([\s\S]*?)(?:<h2 id="[^"]*-seealso"|<awsdocs-copyright|$)/,
    );
    if (examplesMatch) {
      const examplesHtml = examplesMatch[1];

      // Match each example section (h3)
      const exampleSections = examplesHtml.split(/<h3 id="[^"]*">/);
      for (let i = 1; i < exampleSections.length && i <= 3; i++) {
        // Limit to first 3 examples
        const section = exampleSections[i];

        // Extract title
        const titleMatch = section.match(/^([^<]+)</);
        const title = titleMatch ? stripHtml(titleMatch[1]) : `Example ${i}`;

        // Extract description (paragraph before code)
        const descMatch = section.match(/<\/h3>[\s\S]*?<p>([\s\S]*?)<\/p>/);
        const description = descMatch ? htmlToMarkdown(descMatch[1]) : "";

        // Extract JSON code
        let json: string | undefined;
        const jsonMatch = section.match(
          /<div id="JSON"[\s\S]*?<code class="json[^"]*">([\s\S]*?)<\/code>/,
        );
        if (jsonMatch) {
          // Preserve newlines in JSON by just stripping tags
          json = jsonMatch[1]
            .replace(/<span>\{<\/span>/g, "{")
            .replace(/<[^>]+>/g, "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, " ")
            .trim();
        }

        // Extract YAML code
        let yaml: string | undefined;
        const yamlMatch = section.match(
          /<div id="YAML"[\s\S]*?<code class="yaml[^"]*">([\s\S]*?)<\/code>/,
        );
        if (yamlMatch) {
          // Preserve newlines in YAML by just stripping tags
          yaml = yamlMatch[1]
            .replace(/<[^>]+>/g, "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, " ")
            .trim();
        }

        if (title && (json || yaml)) {
          result.examples.push({ title, description, json, yaml });
        }
      }
    }

    return result;
  } catch (error) {
    console.error(`  Error parsing ${docUrl}:`, error);
    failedRequests++;
    return null;
  }
}

// Generate markdown for a resource
function generateResourceMarkdown(
  resourceName: string,
  fullType: string,
  resource: ResourceType,
  relatedStructs: Map<string, PropertyType>,
  scraped: ScrapedResourceData | null,
  structScraped: Map<string, ScrapedPropertyTypeData>,
): string {
  const lines: string[] = [];

  lines.push(`# ${resourceName}`);
  lines.push("");
  lines.push(`CloudFormation Type: \`${fullType}\``);
  lines.push("");

  if (resource.Documentation) {
    lines.push(`[AWS Documentation](${resource.Documentation})`);
    lines.push("");
  }

  // Add scraped description
  if (scraped?.description) {
    lines.push(scraped.description);
    lines.push("");
  }

  // Properties section
  if (resource.Properties && Object.keys(resource.Properties).length > 0) {
    lines.push("# Properties");
    lines.push("");

    const sortedProps = Object.entries(resource.Properties).sort(([a], [b]) =>
      a.localeCompare(b),
    );

    for (const [name, prop] of sortedProps) {
      const type = formatType(prop);
      const required = prop.Required ? "Yes" : "No";
      const updateType = prop.UpdateType ?? "N/A";

      lines.push(`## ${name}`);
      lines.push("");

      // Get scraped description
      const scrapedProp = scraped?.propertyDescriptions.get(name);
      if (scrapedProp?.description) {
        lines.push(scrapedProp.description);
        lines.push("");
      }

      lines.push(`- **Required**: ${required}`);
      lines.push(`- **Type**: ${type}`);
      lines.push(`- **Update**: ${updateType}`);

      // Add allowed values if present
      if (scrapedProp?.allowedValues && scrapedProp.allowedValues.length > 0) {
        lines.push(
          `- **Allowed Values**: \`${scrapedProp.allowedValues.join("` | `")}\``,
        );
      }

      lines.push("");
    }
  }

  // Attributes section
  if (resource.Attributes && Object.keys(resource.Attributes).length > 0) {
    lines.push("# Attributes");
    lines.push("");

    const sortedAttrs = Object.entries(resource.Attributes).sort(([a], [b]) =>
      a.localeCompare(b),
    );

    for (const [name, attr] of sortedAttrs) {
      const type = formatType(attr);

      lines.push(`## ${name}`);
      lines.push("");

      // Find scraped return value description
      const returnVal = scraped?.returnValues.find((rv) => rv.name === name);
      if (returnVal?.description) {
        lines.push(returnVal.description);
        lines.push("");
      }

      lines.push(`- **Type**: ${type}`);
      if (returnVal?.example) {
        lines.push(`- **Example**: \`${returnVal.example}\``);
      }
      lines.push("");
    }
  }

  // Examples section
  if (scraped?.examples && scraped.examples.length > 0) {
    lines.push("# Examples");
    lines.push("");

    for (const example of scraped.examples) {
      lines.push(`## ${example.title}`);
      lines.push("");
      if (example.description) {
        lines.push(example.description);
        lines.push("");
      }
      if (example.yaml) {
        lines.push("```yaml");
        lines.push(example.yaml);
        lines.push("```");
        lines.push("");
      } else if (example.json) {
        lines.push("```json");
        lines.push(example.json);
        lines.push("```");
        lines.push("");
      }
    }
  }

  // Related structs section
  if (relatedStructs.size > 0) {
    lines.push("# Property Types");
    lines.push("");

    const sortedStructs = Array.from(relatedStructs.entries()).sort(
      ([a], [b]) => a.localeCompare(b),
    );

    for (const [structName, struct] of sortedStructs) {
      lines.push(`## ${structName}`);
      lines.push("");

      // Get scraped description for this struct
      const scrapedStruct = structScraped.get(structName);
      if (scrapedStruct?.description) {
        lines.push(scrapedStruct.description);
        lines.push("");
      }

      if (struct.Properties && Object.keys(struct.Properties).length > 0) {
        const sortedProps = Object.entries(struct.Properties).sort(([a], [b]) =>
          a.localeCompare(b),
        );

        for (const [name, prop] of sortedProps) {
          const type = formatType(prop);
          const required = prop.Required ? "Yes" : "No";
          const updateType = prop.UpdateType ?? "N/A";

          lines.push(`### ${name}`);
          lines.push("");

          // Get scraped property description
          const scrapedProp = scrapedStruct?.propertyDescriptions.get(name);
          if (scrapedProp?.description) {
            lines.push(scrapedProp.description);
            lines.push("");
          }

          lines.push(`- **Required**: ${required}`);
          lines.push(`- **Type**: ${type}`);
          lines.push(`- **Update**: ${updateType}`);

          // Add allowed values if present
          if (
            scrapedProp?.allowedValues &&
            scrapedProp.allowedValues.length > 0
          ) {
            lines.push(
              `- **Allowed Values**: \`${scrapedProp.allowedValues.join("` | `")}\``,
            );
          }

          lines.push("");
        }
      }
    }
  }

  return lines.join("\n");
}

async function main() {
  console.log("Fetching CloudFormation spec...");
  const res = await fetch(CFN_SPEC_URL);
  const json = (await res.json()) as CFNSpec;

  console.log(`Version: ${json.ResourceSpecificationVersion}`);
  console.log(`Resources: ${Object.keys(json.ResourceTypes).length}`);
  console.log(`PropertyTypes: ${Object.keys(json.PropertyTypes).length}`);

  const cfnDir = ".external/cfn";

  // Ensure directory exists (don't delete existing files)
  await fs.mkdir(cfnDir, { recursive: true });

  // Group resources by service
  const serviceResources = new Map<
    string,
    Map<string, ResourceType & { _fullType: string }>
  >();
  const servicePropertyTypes = new Map<string, Map<string, PropertyType>>();

  for (const [fullType, resource] of Object.entries(json.ResourceTypes)) {
    const parsed = parseResourceType(fullType);
    if (!parsed) continue;

    const { service, resource: resourceName } = parsed;
    if (!serviceResources.has(service)) {
      serviceResources.set(service, new Map());
    }
    serviceResources.get(service)!.set(resourceName, {
      ...resource,
      _fullType: fullType,
    });
  }

  // Group property types by service and resource
  for (const [fullType, propType] of Object.entries(json.PropertyTypes)) {
    const parsed = parsePropertyType(fullType);
    if (!parsed) continue;

    const { service, resource } = parsed;
    const key = `${service}::${resource}`;
    if (!servicePropertyTypes.has(key)) {
      servicePropertyTypes.set(key, new Map());
    }
    servicePropertyTypes.get(key)!.set(parsed.propertyType, propType);
  }

  console.log(`\nGenerating markdown for ${serviceResources.size} services...`);
  console.log(
    `(Scraping AWS documentation with ${CONCURRENCY} concurrent requests...)\n`,
  );

  // Create service directories first
  for (const service of serviceResources.keys()) {
    const serviceDir = path.join(cfnDir, toKebabCase(service));
    await fs.mkdir(serviceDir, { recursive: true });
  }

  // Collect all resources to process
  const allResources: Array<{
    service: string;
    resourceName: string;
    resource: ResourceType & { _fullType: string };
    relatedStructs: Map<string, PropertyType>;
  }> = [];

  for (const [service, resources] of serviceResources) {
    for (const [resourceName, resource] of resources) {
      const key = `${service}::${resourceName}`;
      const relatedStructs = servicePropertyTypes.get(key) ?? new Map();
      allResources.push({ service, resourceName, resource, relatedStructs });
    }
  }

  // Helper to check if file exists
  async function fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // Filter to only resources that need processing
  const resourcesToProcess: typeof allResources = [];
  let skippedCount = 0;

  for (const item of allResources) {
    const serviceDir = path.join(cfnDir, toKebabCase(item.service));
    const filePath = path.join(serviceDir, `${item.resourceName}.md`);
    if (await fileExists(filePath)) {
      console.log(`Skipping ${filePath} (already exists)`);
      skippedCount++;
    } else {
      resourcesToProcess.push(item);
    }
  }

  if (skippedCount > 0) {
    console.log(`Skipping ${skippedCount} resources (already exist)`);
  }

  const totalToProcess = resourcesToProcess.length;
  if (totalToProcess === 0) {
    console.log("All resources already processed. Nothing to do.");
    return;
  }

  console.log(`Processing ${totalToProcess} resources...\n`);

  let processedResources = 0;
  let scrapedCount = 0;

  // Concurrency limiter for HTTP requests
  const limit = createLimiter(CONCURRENCY);

  // Process all resources in parallel with limited concurrency
  await Promise.all(
    resourcesToProcess.map(
      async ({ service, resourceName, resource, relatedStructs }) => {
        const fullType = resource._fullType;

        // Scrape the AWS documentation (with concurrency limit)
        let scraped: ScrapedResourceData | null = null;
        if (resource.Documentation) {
          scraped = await limit(() =>
            scrapeResourceDocs(resource.Documentation!),
          );
          if (scraped) {
            scrapedCount++;
          }
        }

        // Scrape property type documentation in parallel
        const structEntries = Array.from(relatedStructs.entries()).filter(
          ([, struct]) => struct.Documentation,
        );
        const scrapedStructResults = await Promise.all(
          structEntries.map(async ([structName, struct]) => {
            const scrapedStruct = await limit(() =>
              scrapePropertyTypeDocs(struct.Documentation!),
            );
            return [structName, scrapedStruct] as const;
          }),
        );

        const structScraped = new Map<string, ScrapedPropertyTypeData>();
        for (const [structName, scrapedStruct] of scrapedStructResults) {
          if (scrapedStruct) {
            structScraped.set(structName, scrapedStruct);
          }
        }

        const markdown = generateResourceMarkdown(
          resourceName,
          fullType,
          resource,
          relatedStructs,
          scraped,
          structScraped,
        );

        const serviceDir = path.join(cfnDir, toKebabCase(service));
        const filePath = path.join(serviceDir, `${resourceName}.md`);
        await fs.writeFile(filePath, markdown);

        processedResources++;
        if (processedResources % 100 === 0) {
          console.log(
            `  Progress: ${processedResources}/${totalToProcess} (${Math.round((processedResources / totalToProcess) * 100)}%)`,
          );
        }
      },
    ),
  );

  console.log(`\nDone! Generated ${totalToProcess} resource docs.`);
  console.log(`Successfully scraped ${scrapedCount} AWS documentation pages.`);

  if (failedRequests > 0) {
    console.warn(
      `\n⚠️  Warning: ${failedRequests} requests failed - some docs may be incomplete`,
    );
    process.exit(1);
  }
}

main().catch(console.error);
