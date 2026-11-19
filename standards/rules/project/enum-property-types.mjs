function getPropertyName(key) {
  if (!key) {
    return null;
  }
  if (key.type === "Identifier") {
    return key.name;
  }
  if (key.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }
  return null;
}

function isNullishType(node) {
  return node.type === "TSNullKeyword" || node.type === "TSUndefinedKeyword";
}

function isStringType(node) {
  if (node.type === "TSStringKeyword") {
    return true;
  }
  if (node.type === "TSLiteralType") {
    return typeof node.literal?.value === "string";
  }
  if (node.type === "TSTypeReference") {
    return node.typeName?.type === "Identifier" && node.typeName.name === "String";
  }
  return false;
}

function isStringArrayType(node) {
  if (node.type === "TSArrayType") {
    return isStringType(node.elementType);
  }
  if (node.type === "TSTypeReference") {
    if (node.typeName?.type !== "Identifier") {
      return false;
    }
    const name = node.typeName.name;
    if (name !== "Array" && name !== "ReadonlyArray") {
      return false;
    }
    const typeParams = node.typeParameters?.params ?? [];
    return typeParams.length === 1 && isStringType(typeParams[0]);
  }
  return false;
}

function isStringishOrNullishUnion(node) {
  if (isStringType(node) || isStringArrayType(node)) {
    return true;
  }
  if (node.type !== "TSUnionType") {
    return false;
  }
  const members = node.types.filter((type) => !isNullishType(type));
  if (members.length === 0) {
    return false;
  }
  return members.every((type) => isStringType(type) || isStringArrayType(type));
}

function getMemberPropertyName(memberExpression) {
  if (!memberExpression || memberExpression.type !== "MemberExpression") {
    return null;
  }
  if (memberExpression.property?.type === "Identifier" && !memberExpression.computed) {
    return memberExpression.property.name;
  }
  return null;
}

function isZodStringSchemaExpression(node) {
  if (!node || node.type !== "CallExpression") {
    return false;
  }

  const propertyName = getMemberPropertyName(node.callee);
  if (!propertyName) {
    return false;
  }

  if (propertyName === "string") {
    return true;
  }

  if (
    [
      "optional",
      "nullable",
      "nullish",
      "default",
      "describe",
      "refine",
      "transform",
      "catch",
      "brand",
      "pipe",
      "readonly",
    ].includes(propertyName)
  ) {
    return isZodStringSchemaExpression(node.callee.object);
  }

  return false;
}

function isZodStringArraySchemaExpression(node) {
  if (!node || node.type !== "CallExpression") {
    return false;
  }

  const propertyName = getMemberPropertyName(node.callee);
  if (!propertyName) {
    return false;
  }

  if (propertyName === "array") {
    return node.arguments.length === 1 && isZodStringSchemaExpression(node.arguments[0]);
  }

  if (
    [
      "optional",
      "nullable",
      "nullish",
      "default",
      "describe",
      "refine",
      "transform",
      "catch",
      "brand",
      "pipe",
      "readonly",
    ].includes(propertyName)
  ) {
    return isZodStringArraySchemaExpression(node.callee.object);
  }

  return false;
}

function isObjectPropertyNode(node) {
  return node.type === "Property" && node.kind === "init";
}

function isAllowedType(node, allowedNames) {
  if (node.type === "TSTypeReference") {
    if (node.typeName?.type === "Identifier" && allowedNames.includes(node.typeName.name)) {
      return true;
    }
    if (node.typeName?.type === "Identifier") {
      const name = node.typeName.name;
      if (name === "Array" || name === "ReadonlyArray") {
        const typeParams = node.typeParameters?.params ?? [];
        return (
          typeParams.length === 1 &&
          typeParams[0].type === "TSTypeReference" &&
          typeParams[0].typeName?.type === "Identifier" &&
          allowedNames.includes(typeParams[0].typeName.name)
        );
      }
    }
  }
  if (node.type === "TSArrayType") {
    return (
      node.elementType.type === "TSTypeReference" &&
      node.elementType.typeName?.type === "Identifier" &&
      allowedNames.includes(node.elementType.typeName.name)
    );
  }
  if (node.type === "TSUnionType") {
    const members = node.types.filter((type) => !isNullishType(type));
    if (members.length === 0) {
      return false;
    }
    return members.every((type) => isAllowedType(type, allowedNames));
  }
  return false;
}

const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Require enum-backed types for the property names listed in the rule options.",
    },
    messages: {
      preferEnum: "Property '{{prop}}' should use enum type(s): {{allowed}}. {{hint}}",
    },
    schema: [
      {
        type: "object",
        properties: {
          properties: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                types: { type: "array", items: { type: "string" } },
                hint: { type: "string" },
              },
              required: ["types"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const configured = context.options[0]?.properties ?? {};

    function report(node, name) {
      const { types, hint } = configured[name];
      context.report({
        node,
        messageId: "preferEnum",
        data: { prop: name, allowed: types.join(" | "), hint: hint ?? "" },
      });
    }

    function check(node) {
      const name = getPropertyName(node.key ?? node.property ?? null);
      if (!name || !Object.hasOwn(configured, name)) {
        return;
      }
      const typeAnnotation = node.typeAnnotation?.typeAnnotation;
      if (!typeAnnotation || isAllowedType(typeAnnotation, configured[name].types)) {
        return;
      }
      if (!isStringishOrNullishUnion(typeAnnotation)) {
        return;
      }
      report(node.typeAnnotation, name);
    }

    function checkObjectProperty(node) {
      const name = getPropertyName(node.key);
      if (!name || !Object.hasOwn(configured, name)) {
        return;
      }
      if (
        !isZodStringSchemaExpression(node.value) &&
        !isZodStringArraySchemaExpression(node.value)
      ) {
        return;
      }
      report(node.value, name);
    }

    return {
      TSPropertySignature: check,
      PropertyDefinition: check,
      Property(node) {
        if (isObjectPropertyNode(node)) {
          checkObjectProperty(node);
        }
      },
    };
  },
};

export default {
  rules: {
    "prefer-enum-property-types": rule,
  },
};
