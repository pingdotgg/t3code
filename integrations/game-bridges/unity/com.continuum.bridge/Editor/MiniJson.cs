using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Continuum.Bridge
{
    /// <summary>Small JSON reader and writer: objects become Dictionary, arrays List, numbers double.</summary>
    public static class MiniJson
    {
        public static object Parse(string json)
        {
            var reader = new Reader(json);
            var value = reader.ReadValue();
            reader.SkipWhitespace();
            if (!reader.AtEnd) throw new FormatException("Unexpected trailing JSON.");
            return value;
        }

        public static string Serialize(object value)
        {
            var builder = new StringBuilder();
            Write(builder, value);
            return builder.ToString();
        }

        static void Write(StringBuilder builder, object value)
        {
            switch (value)
            {
                case null: builder.Append("null"); return;
                case string text: WriteString(builder, text); return;
                case bool flag: builder.Append(flag ? "true" : "false"); return;
                case float number: WriteNumber(builder, number); return;
                case double number: WriteNumber(builder, number); return;
                case int number: builder.Append(number.ToString(CultureInfo.InvariantCulture)); return;
                case long number: builder.Append(number.ToString(CultureInfo.InvariantCulture)); return;
                case uint number: builder.Append(number.ToString(CultureInfo.InvariantCulture)); return;
                case IDictionary<string, object> map:
                {
                    builder.Append('{');
                    var first = true;
                    foreach (var pair in map)
                    {
                        if (!first) builder.Append(',');
                        first = false;
                        WriteString(builder, pair.Key);
                        builder.Append(':');
                        Write(builder, pair.Value);
                    }
                    builder.Append('}');
                    return;
                }
                case IEnumerable sequence:
                {
                    builder.Append('[');
                    var first = true;
                    foreach (var item in sequence)
                    {
                        if (!first) builder.Append(',');
                        first = false;
                        Write(builder, item);
                    }
                    builder.Append(']');
                    return;
                }
                default:
                    WriteString(builder, Convert.ToString(value, CultureInfo.InvariantCulture));
                    return;
            }
        }

        static void WriteNumber(StringBuilder builder, double number)
        {
            if (double.IsNaN(number) || double.IsInfinity(number)) builder.Append("null");
            else builder.Append(number.ToString("R", CultureInfo.InvariantCulture));
        }

        static void WriteString(StringBuilder builder, string text)
        {
            builder.Append('"');
            foreach (var character in text)
            {
                switch (character)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (character < 0x20) builder.Append("\\u").Append(((int)character).ToString("x4"));
                        else builder.Append(character);
                        break;
                }
            }
            builder.Append('"');
        }

        sealed class Reader
        {
            readonly string text;
            int index;
            public Reader(string text) { this.text = text; }
            public bool AtEnd => index >= text.Length;

            public void SkipWhitespace()
            {
                while (index < text.Length && char.IsWhiteSpace(text[index])) index++;
            }

            public object ReadValue()
            {
                SkipWhitespace();
                if (AtEnd) throw new FormatException("Unexpected end of JSON.");
                var character = text[index];
                switch (character)
                {
                    case '{': return ReadObject();
                    case '[': return ReadArray();
                    case '"': return ReadString();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    default: return ReadNumber();
                }
            }

            void Expect(string word)
            {
                if (string.CompareOrdinal(text, index, word, 0, word.Length) != 0) throw new FormatException($"Expected {word}.");
                index += word.Length;
            }

            Dictionary<string, object> ReadObject()
            {
                var map = new Dictionary<string, object>();
                index++;
                SkipWhitespace();
                if (text[index] == '}') { index++; return map; }
                while (true)
                {
                    SkipWhitespace();
                    var key = ReadString();
                    SkipWhitespace();
                    if (text[index++] != ':') throw new FormatException("Expected ':'.");
                    map[key] = ReadValue();
                    SkipWhitespace();
                    var next = text[index++];
                    if (next == '}') return map;
                    if (next != ',') throw new FormatException("Expected ',' or '}'.");
                }
            }

            List<object> ReadArray()
            {
                var list = new List<object>();
                index++;
                SkipWhitespace();
                if (text[index] == ']') { index++; return list; }
                while (true)
                {
                    list.Add(ReadValue());
                    SkipWhitespace();
                    var next = text[index++];
                    if (next == ']') return list;
                    if (next != ',') throw new FormatException("Expected ',' or ']'.");
                }
            }

            string ReadString()
            {
                if (text[index] != '"') throw new FormatException("Expected a string.");
                index++;
                var builder = new StringBuilder();
                while (true)
                {
                    if (AtEnd) throw new FormatException("Unterminated string.");
                    var character = text[index++];
                    if (character == '"') return builder.ToString();
                    if (character != '\\') { builder.Append(character); continue; }
                    var escape = text[index++];
                    switch (escape)
                    {
                        case 'n': builder.Append('\n'); break;
                        case 'r': builder.Append('\r'); break;
                        case 't': builder.Append('\t'); break;
                        case 'b': builder.Append('\b'); break;
                        case 'f': builder.Append('\f'); break;
                        case 'u':
                            builder.Append((char)Convert.ToInt32(text.Substring(index, 4), 16));
                            index += 4;
                            break;
                        default: builder.Append(escape); break;
                    }
                }
            }

            object ReadNumber()
            {
                var start = index;
                while (index < text.Length && "+-0123456789.eE".IndexOf(text[index]) >= 0) index++;
                if (start == index) throw new FormatException($"Unexpected character '{text[index]}'.");
                return double.Parse(text.Substring(start, index - start), NumberStyles.Float, CultureInfo.InvariantCulture);
            }
        }
    }
}
