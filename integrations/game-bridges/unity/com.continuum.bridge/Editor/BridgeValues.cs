using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace Continuum.Bridge
{
    /// <summary>Converts serialized properties to and from JSON values.</summary>
    public static class BridgeValues
    {
        public static Dictionary<string, object> Vector(Vector3 value) =>
            new Dictionary<string, object> { ["x"] = value.x, ["y"] = value.y, ["z"] = value.z };

        public static Vector3 ToVector3(object value)
        {
            if (value is Dictionary<string, object> map)
                return new Vector3(Float(map, "x"), Float(map, "y"), Float(map, "z"));
            if (value is List<object> list && list.Count == 3)
                return new Vector3(Convert.ToSingle(list[0]), Convert.ToSingle(list[1]), Convert.ToSingle(list[2]));
            throw new ArgumentException("Expected {x,y,z} or [x,y,z].");
        }

        static float Float(Dictionary<string, object> map, string key) =>
            map.TryGetValue(key, out var value) && value != null ? Convert.ToSingle(value) : 0f;

        /// <summary>Top-level visible properties, as the Inspector shows them.</summary>
        public static Dictionary<string, object> Read(SerializedObject serialized)
        {
            var result = new Dictionary<string, object>();
            var property = serialized.GetIterator();
            var enter = true;
            var count = 0;
            while (property.NextVisible(enter) && count < 80)
            {
                enter = false;
                if (property.name == "m_Script") continue;
                result[property.propertyPath] = Get(property);
                count++;
            }
            return result;
        }

        public static object Get(SerializedProperty property)
        {
            switch (property.propertyType)
            {
                case SerializedPropertyType.Integer: return property.longValue;
                case SerializedPropertyType.Boolean: return property.boolValue;
                case SerializedPropertyType.Float: return property.doubleValue;
                case SerializedPropertyType.String: return property.stringValue;
                case SerializedPropertyType.Color:
                    var color = property.colorValue;
                    return new Dictionary<string, object> { ["r"] = color.r, ["g"] = color.g, ["b"] = color.b, ["a"] = color.a };
                case SerializedPropertyType.ObjectReference:
                    var reference = property.objectReferenceValue;
                    return reference == null ? null : new Dictionary<string, object> { ["name"] = reference.name, ["type"] = reference.GetType().Name, ["asset"] = AssetDatabase.GetAssetPath(reference) };
                case SerializedPropertyType.Enum:
                    return property.enumValueIndex >= 0 && property.enumValueIndex < property.enumNames.Length ? property.enumNames[property.enumValueIndex] : (object)property.intValue;
                case SerializedPropertyType.Vector2: return new Dictionary<string, object> { ["x"] = property.vector2Value.x, ["y"] = property.vector2Value.y };
                case SerializedPropertyType.Vector3: return Vector(property.vector3Value);
                case SerializedPropertyType.Quaternion: return Vector(property.quaternionValue.eulerAngles);
                case SerializedPropertyType.Rect:
                    var rect = property.rectValue;
                    return new Dictionary<string, object> { ["x"] = rect.x, ["y"] = rect.y, ["width"] = rect.width, ["height"] = rect.height };
                case SerializedPropertyType.ArraySize: return property.intValue;
                default:
                    return property.isArray ? (object)$"array[{property.arraySize}]" : property.propertyType.ToString();
            }
        }

        public static void Set(SerializedObject serialized, string path, object value)
        {
            var property = serialized.FindProperty(path) ?? throw new ArgumentException($"No serialized property {path} on {serialized.targetObject.GetType().Name}");
            switch (property.propertyType)
            {
                case SerializedPropertyType.Integer: property.longValue = Convert.ToInt64(value); break;
                case SerializedPropertyType.Boolean: property.boolValue = Convert.ToBoolean(value); break;
                case SerializedPropertyType.Float: property.doubleValue = Convert.ToDouble(value); break;
                case SerializedPropertyType.String: property.stringValue = Convert.ToString(value); break;
                case SerializedPropertyType.Enum:
                    if (value is string name) property.enumValueIndex = Array.IndexOf(property.enumNames, name);
                    else property.enumValueIndex = Convert.ToInt32(value);
                    if (property.enumValueIndex < 0) throw new ArgumentException($"{path} has no value {value}");
                    break;
                case SerializedPropertyType.Color:
                    var map = (Dictionary<string, object>)value;
                    property.colorValue = new Color(Float(map, "r"), Float(map, "g"), Float(map, "b"), map.ContainsKey("a") ? Float(map, "a") : 1f);
                    break;
                case SerializedPropertyType.Vector2:
                    var v2 = ToVector3(value is Dictionary<string, object> m && !m.ContainsKey("z") ? new Dictionary<string, object>(m) { ["z"] = 0.0 } : value);
                    property.vector2Value = new Vector2(v2.x, v2.y);
                    break;
                case SerializedPropertyType.Vector3: property.vector3Value = ToVector3(value); break;
                case SerializedPropertyType.Quaternion: property.quaternionValue = Quaternion.Euler(ToVector3(value)); break;
                case SerializedPropertyType.ObjectReference:
                    if (value == null) { property.objectReferenceValue = null; break; }
                    var assetPath = value is Dictionary<string, object> reference && reference.TryGetValue("asset", out var asset) ? (string)asset : Convert.ToString(value);
                    property.objectReferenceValue = AssetDatabase.LoadMainAssetAtPath(assetPath) ?? throw new ArgumentException($"No asset at {assetPath}");
                    break;
                default:
                    throw new ArgumentException($"{path} is a {property.propertyType}, which the bridge cannot set yet.");
            }
        }
    }
}
