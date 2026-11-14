/**
 * Archive/structure fixtures for the office + EPUB extraction test.
 * Pure data, so the test body stays readable and this file stays under the size limit.
 */
export const documentExtractionCases = [
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml": "<document><p>Readable despite embedded media</p></document>",
            "word/media/black.bmp": "\0".repeat(64 * 1024),
            "word/embeddings/unused.bin": "\0".repeat(33 * 1024 * 1024),
          },
          expected: ["Readable despite embedded media"],
          absent: ["[Extracted text truncated"],
        },
        ...[false, true].map((deep) => ({
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml": `<document>${deep ? "<div>".repeat(129) + "Lost" + "</div>".repeat(129) : "<p/>".repeat(200_001)}</document>`,
          },
          expected: ["[Extracted text truncated at document extraction limits.]"],
          absent: ["Lost"],
        })),
        ...["ods", "odt", "odp", "docx"].flatMap((ext) =>
          [false, true].map((rows) => ({
            ext,
            bounded: true,
            parts: {
              [ext === "docx" ? "word/document.xml" : "content.xml"]:
                `<document><page><table><table-row${rows ? ' number-rows-repeated="10001"' : ""}><table-cell${rows ? "" : ' number-columns-repeated="513"'}><p>Repeated value</p></table-cell></table-row></table></page></document>`,
            },
            expected: [
              "Repeated value",
              "[Extracted text truncated at document extraction limits.]",
            ],
            occurrences: { text: "Repeated value", count: rows ? 10_000 : 512 },
          })),
        ),
        ...["ods", "odt", "odp", "docx"].map((ext) => ({
          ext,
          bounded: true,
          parts: {
            [ext === "docx" ? "word/document.xml" : "content.xml"]:
              `<document><page><table><table-row><table-cell><p>Kept</p></table-cell><table-cell number-columns-repeated="16383"> \n <p> \t </p> <s c="1048575"/> </table-cell></table-row><table-row number-rows-repeated="1048575"><table-cell> \n <p> \t </p> </table-cell></table-row></table></page></document>`,
          },
          expected: ["Kept"],
          absent: ["[Extracted text truncated", "\t"],
        })),
        ...["ods", "odt", "odp"].map((ext) => ({
          ext,
          bounded: true,
          parts: {
            "content.xml": `<document><page><table><table-row>
              <table-cell office:value-type="string" office:string-value="Harbor"/>
              <table-cell office:value-type="boolean" office:boolean-value="false"/>
              <table-cell office:value-type="date" office:date-value="2026-10-20"/>
              <table-cell office:value-type="time" office:time-value="PT2H30M"/>
              <table-cell office:value-type="currency" office:value="125.50" office:currency="USD"/>
              <table-cell office:value-type="percentage" office:value="0.25"/>
              <table-cell office:value-type="float" office:value="0"/>
              <table-cell office:value-type="string" office:string-value="Fallback"><p> \n </p></table-cell>
              <table-cell office:value-type="string" office:string-value="Unshown"><p>Displayed</p></table-cell>
              <table-cell office:value-type="void" office:value="Unshown"/>
              <table-cell office:value-type="currency" office:value=" " office:currency="Unshown"/>
              <table-cell office:value-type="percentage" office:value=" "/>
            </table-row></table></page></document>`,
          },
          expected: [
            "Harbor\tfalse\t2026-10-20\tPT2H30M\t125.50 USD\t0.25 [ODF value-type=percentage]\t0\tFallback\tDisplayed",
          ],
          absent: ["Unshown", "[Extracted text truncated"],
        })),
        ...[false, true].map((rows) => ({
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml": '<workbook><sheet name="Limited" r:id="a"/></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
            "xl/worksheets/a.xml": `<worksheet>${rows ? "<row><c><v>7</v></c></row>".repeat(10_001) : '<row><c r="A1"><v>7</v></c><c r="SS1"><v>Beyond</v></c></row>'}</worksheet>`,
          },
          expected: ["7", "[Extracted text truncated at document extraction limits.]"],
          absent: ["Beyond"],
        })),
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml": '<workbook><sheet name="Padding" r:id="a"/></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
            "xl/sharedStrings.xml": "<sst><si><t> \n </t></si><si><t>Present</t></si></sst>",
            "xl/worksheets/a.xml": `<worksheet>${'<row><c t="s"><v>0</v></c><c r="XFD1" t="inlineStr"><is><t> \t </t></is></c></row>'.repeat(10_001)}<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c r="XFD2"><v> \n </v></c></row></worksheet>`,
          },
          expected: ["Present"],
          absent: ["[Extracted text truncated"],
        },
        {
          ext: "epub",
          parts: {
            "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
            "book.opf":
              '<package><item id="bad" href="ch%ZZ.xhtml"/><item id="good" href="good.svg"/><itemref idref="bad"/><itemref idref="good"/></package>',
            "good.svg":
              '<svg xmlns="http://www.w3.org/2000/svg"><text>Readable SVG chapter</text></svg>',
          },
          expected: [
            "Readable SVG chapter",
            "[Skipped document part: chapter 1 (missing or invalid XML).]",
          ],
          absent: ["[Extracted text truncated"],
        },
        ...[false, true].flatMap((bom) =>
          [false, true].map((bigEndian) => {
            const encode = (source: string) => {
              const data = Buffer.from(`${bom ? "\ufeff" : ""}${source}`, "utf16le");
              return bigEndian ? data.swap16() : data;
            };
            return {
              ext: "epub",
              parts: {
                "META-INF/container.xml": encode(
                  '<?xml version="1.0" encoding="UTF-16"?><container><rootfile full-path="book.opf"/></container>',
                ),
                "book.opf": encode(
                  '<?xml version="1.0" encoding="UTF-16"?><package><item id="a" href="a.xhtml"/><itemref idref="a"/></package>',
                ),
                "a.xhtml": encode(
                  '<?xml version="1.0" encoding="UTF-16"?><html><p>UTF-16 chapter: café 日本語</p></html>',
                ),
              },
              expected: ["UTF-16 chapter: café 日本語"],
              absent: ["[Skipped document part", "[Extracted text truncated"],
            };
          }),
        ),
        {
          ext: "epub",
          bounded: true,
          parts: {
            "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
            "book.opf":
              '<package><item id="bad" href="bad.xhtml"/><item id="good" href="good.xhtml"/><itemref idref="bad"/><itemref idref="good"/></package>',
            "bad.xhtml": "<html><p>Discard this broken chapter</html>",
            "good.xhtml":
              '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><p>North&nbsp;Harbor &NotEqualTilde; &CounterClockwiseContourIntegral; &amp; &lt;tag&gt; &quot;quoted&quot;</p><p><![CDATA[Literal &nbsp;]]></p><table><tr><td>&nbsp; </td></tr><tr><td>Kept&nbsp;cell</td></tr></table></html>',
          },
          expected: [
            "## Chapter 2",
            'North\u00a0Harbor ≂̸ ∳ & <tag> "quoted"',
            "Literal &nbsp;",
            "Kept cell",
            "[Skipped document part: bad.xhtml (missing or invalid XML).]",
          ],
          absent: ["Discard this broken chapter", "[Extracted text truncated"],
        },
        ...["pptx", "xlsx"].map((ext) => ({
          ext,
          bounded: true,
          parts:
            ext === "pptx"
              ? {
                  "ppt/presentation.xml":
                    '<presentation><sldId r:id="bad"/><sldId r:id="good"/></presentation>',
                  "ppt/_rels/presentation.xml.rels":
                    '<Relationships><Relationship Id="bad" Target="bad.xml"/><Relationship Id="good" Target="good.xml"/></Relationships>',
                  "ppt/bad.xml": "<slide><p>Discard</slide>",
                  "ppt/good.xml": "<slide><p>Healthy part</p></slide>",
                }
              : {
                  "xl/workbook.xml":
                    '<workbook><sheet name="Bad" r:id="bad"/><sheet name="Good" r:id="good"/></workbook>',
                  "xl/_rels/workbook.xml.rels":
                    '<Relationships><Relationship Id="bad" Target="bad.xml"/><Relationship Id="good" Target="good.xml"/></Relationships>',
                  "xl/bad.xml": "<worksheet><row>Discard</worksheet>",
                  "xl/good.xml":
                    '<worksheet><row><c t="inlineStr"><is><t>Healthy part</t></is></c></row></worksheet>',
                },
          expected: [
            "Healthy part",
            `[Skipped document part: ${ext === "pptx" ? "ppt" : "xl"}/bad.xml (missing or invalid XML).]`,
          ],
          absent: ["Discard", "[Extracted text truncated"],
        })),
        {
          ext: "odt",
          bounded: true,
          parts: { "content.xml": '<document><p>Start<s c="1000001"/>Unneeded</p></document>' },
          expected: ["Start", "[Extracted text truncated at document extraction limits.]"],
          absent: ["Unneeded"],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Callout box</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Callout box</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>',
          },
          expected: ["Body\nCallout box"],
          occurrences: { text: "Callout box", count: 1 },
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body><w:p><w:r><mc:AlternateContent><mc:Choice Requires="cx"><w:drawing><cx:chart/></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Chart caption</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>',
          },
          expected: ["Chart caption"],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Report &amp; totals</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p><w:p><w:r><w:t>34</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Before</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Neighbor</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
          },
          expected: ["## Report & totals", "North\t12 34", "Before Inner After\tNeighbor"],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>First</w:t><w:cr/><w:t>Second</w:t><w:br/><w:t>Third</w:t></w:r></w:p></w:body></w:document>',
          },
          expected: ["First\nSecond\nThird"],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Intro</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t> 3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9350"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">Fee </w:t></w:r><w:del><w:r><w:delText>$500</w:delText></w:r></w:del><w:ins><w:r><w:t>$700</w:t></w:r></w:ins><w:moveFrom><w:r><w:t>Moved</w:t></w:r></w:moveFrom><w:r><w:tab/><w:t>due</w:t></w:r></w:p></w:body></w:document>',
          },
          expected: ["Intro 3\nFee $700\tdue"],
          absent: ["PAGEREF", "$500", "Moved"],
        },
        {
          ext: "odt",
          bounded: true,
          parts: {
            "content.xml":
              "<document><text><tracked-changes><changed-region><deletion><change-info><creator>Reviewer</creator></change-info><p>$500</p></deletion></changed-region></tracked-changes><p>Fee <change/>$700</p></text></document>",
          },
          expected: ["Fee $700"],
          absent: ["Reviewer", "$500"],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml": `<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>${"A".repeat(1_000_000)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Later cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
          },
          expected: ["A".repeat(32), "[Extracted text truncated at document extraction limits.]"],
        },
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml": '<workbook><sheet name="Formulas" r:id="a"/></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
            "xl/styles.xml": '<styleSheet><cellXfs><xf numFmtId="9"/></cellXfs></styleSheet>',
            "xl/worksheets/a.xml":
              "<worksheet><row><c><f>SUM(11,22)</f><v/></c></row><row><c><f>SUM(33,44)</f><v> \n </v></c></row><row><c><f>SUM(55,66)</f></c></row><row><c><f>SUM(11,22)</f><v>33</v></c><c><f>SUM(0,0)</f><v>0</v></c></row></worksheet>",
          },
          expected: [
            "SUM(11,22)\nSUM(33,44)\nSUM(55,66)",
            "33 [Excel numFmtId=9; date system 1900]\t0 [Excel numFmtId=9; date system 1900]",
          ],
          absent: ["SUM(0,0)", "[Extracted text truncated"],
        },
        {
          ext: "xlsx",
          parts: {
            "xl/workbook.xml":
              '<workbook><sheets><sheet name="Inventory" r:id="a"/><sheet name="Budget" r:id="b"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/second.xml"/><Relationship Id="b" Target="worksheets/first.xml"/></Relationships>',
            "xl/sharedStrings.xml": "<sst><si><t>Lantern</t></si></sst>",
            "xl/styles.xml":
              '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/><xf numFmtId="164"/></cellXfs></styleSheet>',
            "xl/worksheets/second.xml":
              '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1"><v>37</v></c></row></sheetData></worksheet>',
            "xl/worksheets/first.xml":
              '<worksheet><sheetData><row><c t="inlineStr"><is><t>Ferry</t></is></c><c><v>628</v></c><c s="1"><v>45292</v></c><c s="2"><v>0.25</v></c><c s="3"><v>45293</v></c></row></sheetData></worksheet>',
          },
          expected: [
            "## Sheet: Inventory",
            "Lantern\t\t37",
            "## Sheet: Budget",
            "Ferry\t628",
            "45292 [Excel numFmtId=14; date system 1900]",
            "0.25 [Excel numFmtId=9; date system 1900]",
            "45293 [Excel numFmtId=164; format=yyyy-mm-dd; date system 1900]",
          ],
        },
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml": '<workbook><sheet name="Phonetics" r:id="a"/></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
            "xl/sharedStrings.xml":
              '<sst><si><t>東京</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh></si></sst>',
            "xl/worksheets/a.xml":
              '<worksheet><row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>東京</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh></is></c></row></worksheet>',
          },
          expected: ["## Sheet: Phonetics", "東京\t東京"],
          absent: ["とうきょう"],
        },
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml":
              '<workbook><workbookPr date1904="true"/><sheets><sheet name="Dates" r:id="a"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/dates.xml"/></Relationships>',
            "xl/styles.xml": '<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>',
            "xl/worksheets/dates.xml":
              "<worksheet><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>",
          },
          expected: ["## Sheet: Dates", "1 [Excel numFmtId=14; date system 1904]"],
        },
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml":
              '<workbook><sheets><sheet name="Repeated" r:id="a"/><sheet name="Unneeded" r:id="missing"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/repeated.xml"/></Relationships>',
            "xl/sharedStrings.xml": `<sst><si><t>${"A".repeat(1_000_000 - "## Sheet: Repeated\n".length)}</t></si></sst>`,
            "xl/worksheets/repeated.xml": `<worksheet><sheetData>${'<row><c t="s"><v>0</v></c><c t="s"><v>0</v></c></row>'.repeat(1_500)}</sheetData></worksheet>`,
          },
          expected: [
            "## Sheet: Repeated",
            "A".repeat(32),
            "[Extracted text truncated at document extraction limits.]",
          ],
        },
        {
          ext: "pptx",
          bounded: true,
          parts: {
            "ppt/presentation.xml":
              '<p:presentation><p:sldIdLst><p:sldId id="1" r:id="b"/><p:sldId id="2" r:id="a"/></p:sldIdLst></p:presentation>',
            "ppt/_rels/presentation.xml.rels":
              '<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>',
            "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Departure</a:t></a:r></a:p></p:sld>",
            "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Juniper Pier</a:t></a:r></a:p></p:sld>",
            "ppt/slides/_rels/slide2.xml.rels":
              '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../notesSlides/ignored.xml"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" TargetMode="External" Target="https://example.com/notes.xml"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notes7.xml"/></Relationships>',
            "ppt/slides/_rels/slide1.xml.rels":
              '<Relationships><Relationship Type="http://purl.oclc.org/ooxml/officeDocument/relationships/notesSlide" Target="/ppt/notesSlides/notes3.xml"/></Relationships>',
            "ppt/notesSlides/notes7.xml":
              "<p:notes><a:p><a:r><a:t>evacuation code ORCHID-81</a:t></a:r></a:p></p:notes>",
            "ppt/notesSlides/notes3.xml":
              "<p:notes><a:p><a:r><a:t>Board at gate 4</a:t></a:r></a:p></p:notes>",
            "ppt/notesSlides/ignored.xml": "<p:notes><a:p>Unrelated notes</a:p></p:notes>",
          },
          expected: [
            "## Slide 1",
            "Juniper Pier\nNotes:\nevacuation code ORCHID-81",
            "## Slide 2",
            "Departure\nNotes:\nBoard at gate 4",
          ],
          absent: ["Unrelated notes", "[Skipped document part", "[Extracted text truncated"],
        },
        ...[false, true].map((missing) => ({
          ext: "pptx",
          bounded: true,
          parts: {
            "ppt/presentation.xml": '<presentation><sldId r:id="a"/></presentation>',
            "ppt/_rels/presentation.xml.rels":
              '<Relationships><Relationship Id="a" Target="slides/a.xml"/></Relationships>',
            "ppt/slides/a.xml": "<slide><p>Slide text</p></slide>",
            "ppt/slides/_rels/a.xml.rels": `<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/${missing ? "missing" : "bad"}.xml"/></Relationships>`,
            "ppt/notesSlides/bad.xml": "<notes><p>Discard broken notes</notes>",
          },
          expected: [
            "Slide text",
            `[Skipped document part: ppt/notesSlides/${missing ? "missing" : "bad"}.xml (missing or invalid XML).]`,
          ],
          absent: ["Discard broken notes", "[Extracted text truncated"],
        })),
        {
          ext: "pptx",
          bounded: true,
          parts: {
            "ppt/presentation.xml":
              '<presentation><sldId r:id="a"/><sldId r:id="b"/></presentation>',
            "ppt/_rels/presentation.xml.rels":
              '<Relationships><Relationship Id="a" Target="slides/a.xml"/><Relationship Id="b" Target="slides/b.xml"/></Relationships>',
            "ppt/slides/a.xml": `<slide><p>${"A".repeat(600_000)}</p></slide>`,
            "ppt/slides/b.xml": "<slide><p>Unneeded slide</p></slide>",
            "ppt/slides/_rels/a.xml.rels":
              '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/a.xml"/></Relationships>',
            "ppt/notesSlides/a.xml": `<notes><p>evacuation code ORCHID-81 ${"B".repeat(600_000)} Unneeded notes</p></notes>`,
          },
          expected: [
            "## Slide 1",
            "A".repeat(32),
            "Notes:\nevacuation code ORCHID-81",
            "B".repeat(32),
            "[Extracted text truncated at document extraction limits.]",
          ],
          absent: ["Unneeded notes", "Unneeded slide", "## Slide 2"],
        },
        {
          ext: "odt",
          parts: {
            "content.xml":
              '<office:document><text:h text:outline-level="2">Orchard</text:h><text:p>19<text:s text:c="3"/>violet<text:s/>crates</text:p></office:document>',
          },
          expected: ["## Orchard", "19   violet crates"],
        },
        {
          ext: "ods",
          parts: {
            "content.xml":
              '<office:document><table:table table:name="Cargo"><table:table-row><table:table-cell><text:p>Violet</text:p></table:table-cell><table:table-cell office:value="19"/><table:table-cell office:value="27"><text:p/></table:table-cell></table:table-row></table:table></office:document>',
          },
          expected: ["## Sheet: Cargo", "Violet\t19\t27"],
        },
        {
          ext: "ods",
          bounded: true,
          parts: {
            "content.xml":
              '<office:document><table:table table:name="Padded rows"><table:table-row><table:table-cell><text:p>Left</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/><table:table-cell><text:p>Right</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell/></table:table-row></table:table></office:document>',
          },
          expected: ["## Sheet: Padded rows", "Left\t\t\tRight"],
          absent: ["[Extracted text truncated"],
        },
        {
          ext: "ods",
          bounded: true,
          parts: {
            "content.xml":
              '<office:document><table:table table:name="Padded"><table:table-row><table:table-cell><text:p>Populated</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16383"/></table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="16384"><text:p/></table:table-cell></table:table-row></table:table></office:document>',
          },
          expected: ["## Sheet: Padded", "Populated"],
          absent: ["[Extracted text truncated", "\t"],
        },
        {
          ext: "ods",
          bounded: true,
          parts: {
            "content.xml": `<office:document><table:table table:name="Repeated"><table:table-row><table:table-cell table:number-columns-repeated="512"><text:p>Lead ${"a".repeat(600_000)} Tail</text:p></table:table-cell></table:table-row></table:table></office:document>`,
          },
          expected: [
            "## Sheet: Repeated",
            "Lead ",
            " Tail\tLead ",
            "[Extracted text truncated at document extraction limits.]",
          ],
        },
        {
          ext: "odp",
          parts: {
            "content.xml":
              "<office:document><draw:page><text:p>First</text:p></draw:page><draw:page><text:p>Second</text:p></draw:page></office:document>",
          },
          expected: ["## Slide 1", "First", "## Slide 2", "Second"],
        },
        {
          ext: "ods",
          bounded: true,
          parts: {
            "content.xml": `<office:document>${Array.from(
              { length: 256 },
              (_, index) =>
                `<table:table table:name="${index === 0 ? "Shared" : "Unneeded"}"><table:table-row><table:table-cell table:number-columns-repeated="512"><text:p>${"B".repeat(4096)}</text:p></table:table-cell></table:table-row></table:table>`,
            ).join("")}</office:document>`,
          },
          expected: [
            "## Sheet: Shared",
            "B".repeat(32),
            "[Extracted text truncated at document extraction limits.]",
          ],
          absent: ["## Sheet: Unneeded"],
        },
        {
          ext: "odt",
          bounded: true,
          parts: {
            "content.xml": `<office:document><text:p>Before whitespace</text:p><table:table><table:table-row table:number-rows-repeated="10000"><table:table-cell table:number-columns-repeated="512"><text:p>${" ".repeat(10_000)}</text:p></table:table-cell></table:table-row></table:table><text:p>Unneeded</text:p></office:document>`,
          },
          expected: ["Before whitespace", "Unneeded"],
          absent: ["[Extracted text truncated"],
        },
        ...["odt", "odp", "ods"].flatMap((ext) =>
          [false, true].map((rows) => ({
            ext,
            bounded: true,
            parts: {
              "content.xml": `<office:document><draw:page>${Array.from(
                { length: 256 },
                () =>
                  `<table:table><table:table-row${rows ? ' table:number-rows-repeated="10000"' : ""}><table:table-cell table:number-columns-repeated="512"><text:p>${"Budget ".repeat(rows ? 160 : 585)}</text:p></table:table-cell></table:table-row></table:table>`,
              ).join(
                "",
              )}</draw:page><draw:page><text:p>Unneeded</text:p></draw:page></office:document>`,
            },
            expected: ["Budget ", "[Extracted text truncated at document extraction limits.]"],
            absent: ["Unneeded"],
          })),
        ),
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml": `<w:document><w:p><w:t>${"A".repeat(1_000_100)}</w:t></w:p><w:p><w:t>Unneeded</w:t></w:p></w:document>`,
          },
          expected: ["A".repeat(32), "[Extracted text truncated at document extraction limits.]"],
          absent: ["Unneeded"],
        },
        {
          ext: "pptx",
          bounded: true,
          parts: {
            "ppt/presentation.xml":
              '<p:presentation><p:sldId r:id="a"/><p:sldId r:id="missing"/></p:presentation>',
            "ppt/_rels/presentation.xml.rels":
              '<Relationships><Relationship Id="a" Target="slides/slide.xml"/></Relationships>',
            "ppt/slides/slide.xml": `<p:sld><a:p><a:t>${"A".repeat(1_000_100)}</a:t></a:p></p:sld>`,
          },
          expected: [
            "## Slide 1",
            "A".repeat(32),
            "[Extracted text truncated at document extraction limits.]",
          ],
          absent: ["## Slide 2"],
        },
        {
          ext: "epub",
          bounded: true,
          parts: {
            "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
            "book.opf":
              '<package><item id="a" href="a.xhtml"/><itemref idref="a"/><itemref idref="missing"/></package>',
            "a.xhtml": `<html><body><p>${"A".repeat(1_000_100)}</p></body></html>`,
          },
          expected: [
            "## Chapter 1",
            "A".repeat(32),
            "[Extracted text truncated at document extraction limits.]",
          ],
          absent: ["## Chapter 2"],
        },
        {
          ext: "epub",
          parts: {
            "META-INF/container.xml":
              '<container><rootfile full-path="OEBPS/book.opf"/></container>',
            "OEBPS/book.opf":
              '<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
            "OEBPS/a.xhtml":
              '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><body><p>Last chapter</p><p>Price <s>10</s> 8</p></body></html>',
            "OEBPS/b.xhtml":
              "<!DOCTYPE html><html><body><h1>First chapter</h1><p>Larkspur</p><div>Direct div<section>Direct section<li>Direct item <em>emphasis</em> trailing</li></section></div><div>Account: A<br/>Balance: 731<line-break/>Currency: USD</div><table><thead><tr><th>Heading</th><th>Total</th></tr></thead><tbody><tr><td>Important value</td><td>731</td></tr><tr><td>Before<table><tr><td>Inner</td></tr></table>After</td><td>Neighbor</td></tr></tbody></table></body></html>",
          },
          expected: [
            "## Chapter 1",
            "# First chapter",
            "Larkspur",
            "Direct div",
            "Direct section",
            "Direct item emphasis trailing",
            "Account: A\nBalance: 731\nCurrency: USD",
            "Heading\tTotal",
            "Important value\t731",
            "Before Inner After\tNeighbor",
            "## Chapter 2",
            "Last chapter",
            "Price 10 8",
          ],
        },
      ];
