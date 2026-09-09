import { Parser } from "node-sql-parser";
import { ModelDefinition, WarehouseColumn } from "./schema";

export type Dialect = "postgres" | "clickhouse";
export interface CompositeCursor {
  value: string;
  primaryKeyValues: string[];
}
export const keyCountColumn = "__jitsu_retl_key_count";
const parser = new Parser();

export function validateQuery(query: string, dialect: Dialect): string {
  if (!query.trim() || query.length > 100_000 || query.includes("\0")) throw new Error("Invalid model query");
  let ast: any;
  try {
    // The parser has no ClickHouse dialect. Initially accept its portable SELECT
    // subset; never fall back to executing unparsed ClickHouse SQL.
    ast = parser.astify(query, { database: dialect === "postgres" ? "Postgresql" : "MySQL" });
  } catch {
    throw new Error("Query must be a single supported read-only SELECT (including SELECT CTEs)");
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1 || statements[0]?.type !== "select") throw new Error("Only one SELECT is allowed");
  function check(value: any) {
    if (!value || typeof value !== "object") return;
    if (
      ["insert", "update", "delete", "replace", "create", "drop", "alter", "call", "set", "execute", "into"].includes(
        value.type
      ) ||
      value.into?.position ||
      value.locking_read ||
      value.for_update
    ) {
      throw new Error("Query must be read-only");
    }
    for (const child of Object.values(value)) check(child);
  }
  check(statements[0]);
  // Preserve source spelling: sqlify quotes identifiers, changing PostgreSQL's
  // case-folding semantics. Only remove the parsed statement's delimiter.
  return withoutDelimiter(query, dialect);
}

function withoutDelimiter(query: string, dialect: Dialect): string {
  let result = "";
  let start = 0;
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (query.startsWith("--", i) || (dialect === "clickhouse" && c === "#")) {
      while (i < query.length && !["\n", "\r"].includes(query[i])) i++;
    } else if (query.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < query.length && depth) {
        if (query.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (query.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      i--;
    } else if (["'", '"', "`"].includes(c)) {
      const escapes =
        dialect === "clickhouse" ||
        (c === "'" && /[eE]/.test(query[i - 1] ?? "") && !/[\w$\u0080-\uFFFF]/.test(query[i - 2] ?? ""));
      for (i++; i < query.length; i++) {
        if (escapes && query[i] === "\\") i++;
        else if (query[i] === c) {
          if (query[i + 1] === c) i++;
          else break;
        }
      }
    } else if (dialect === "postgres" && c === "$" && !/[\w$\u0080-\uFFFF]/.test(query[i - 1] ?? "")) {
      const delimiter = query.slice(i).match(/^\$(?:[a-zA-Z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)?\$/)?.[0];
      if (delimiter) {
        const end = query.indexOf(delimiter, i + delimiter.length);
        if (end < 0) throw new Error("Unterminated SQL literal");
        i = end + delimiter.length - 1;
      }
    } else if (c === ";") {
      result += query.slice(start, i);
      start = i + 1;
    }
  }
  return result + query.slice(start);
}

export function quoteColumn(name: string, dialect: Dialect) {
  const q = dialect === "postgres" ? '"' : "`";
  const escaped = dialect === "clickhouse" ? name.replaceAll("\\", "\\\\") : name;
  return q + escaped.replaceAll(q, q + q) + q;
}

export function validateColumns(model: ModelDefinition, columns: WarehouseColumn[]) {
  const names = columns.map(c => c.name);
  if (new Set(names).size !== names.length) throw new Error("Query returns duplicate column names; use unique aliases");
  if (names.includes(keyCountColumn)) throw new Error(`${keyCountColumn} is reserved`);
  for (const name of [...model.primaryKey, model.cursor?.column, model.deleteColumn].filter(Boolean) as string[]) {
    if (!names.includes(name)) throw new Error(`Query must project column '${name}'`);
  }
  if (model.cursor) {
    const type = columns.find(c => c.name === model.cursor!.column)!.type;
    const unwrapped = type.replace(/^Nullable\((.*)\)$/, "$1");
    const compatible = {
      timestamp: /^(1082|1114|1184|Date|Date32|DateTime(?:\(.*\))?|DateTime64\(.*\))$/,
      number: /^(20|21|23|700|701|1700|U?Int\d+|Float\d+|Decimal\w*\(.*\))$/,
      string: /^(25|1042|1043|2950|String|UUID)$/,
    };
    if (!compatible[model.cursor.type].test(unwrapped))
      throw new Error(`Cursor type '${model.cursor.type}' does not match warehouse type '${type}'`);
  }
}

export function compileModel(
  model: ModelDefinition,
  dialect: Dialect,
  columns: WarehouseColumn[],
  after?: CompositeCursor
) {
  const sql = validateQuery(model.query, dialect);
  validateColumns(model, columns);
  const values: string[] = [];
  const queryParams: Record<string, string> = {};
  const q = (name: string) => quoteColumn(name, dialect);
  const keys = model.primaryKey.map(q).join(", ");
  let where = "";
  const order = model.cursor ? [model.cursor.column, ...model.primaryKey] : model.primaryKey;
  if (after) {
    if (!model.cursor || after.primaryKeyValues.length !== model.primaryKey.length)
      throw new Error("Checkpoint does not match model");
    const checkpointValues = [after.value, ...after.primaryKeyValues];
    const params = (model.cursor.lookbackSeconds ? order.slice(0, 1) : order).map((name, i) => {
      const value = checkpointValues[i];
      if (typeof value !== "string") throw new Error("Checkpoint values must be lossless strings");
      if (dialect === "postgres") {
        values.push(value);
        return `$${values.length}`;
      }
      const type = columns.find(c => c.name === name)!.type;
      // Server-provided metadata must still be restricted before inclusion in SQL.
      if (
        !/^(?:Nullable\()?((?:U?Int(?:8|16|32|64|128|256))|Float(?:32|64)|String|UUID|Date|Date32|DateTime(?:\('[A-Za-z_/+-]+'\))?|DateTime64\(\d+(?:,\s*'[A-Za-z_/+-]+')?\)|Decimal(?:32|64|128|256)?\(\d+(?:,\s*\d+)?\))(?:\))?$/.test(
          type
        )
      ) {
        throw new Error(`Unsupported checkpoint type: ${type}`);
      }
      queryParams[`p${i}`] = value;
      return `{p${i}: ${type}}`;
    });
    if (model.cursor.lookbackSeconds) {
      const seconds = model.cursor.lookbackSeconds;
      where =
        dialect === "postgres"
          ? `${q(model.cursor.column)} >= (${params[0]}::timestamp with time zone - INTERVAL '${seconds} seconds')`
          : `${q(model.cursor.column)} >= subtractSeconds(${params[0]}, ${seconds})`;
    } else {
      where = order
        .map(
          (name, i) =>
            `(${[...order.slice(0, i).map((n, j) => `${q(n)} = ${params[j]}`), `${q(name)} > ${params[i]}`].join(
              " AND "
            )})`
        )
        .join(" OR ");
    }
  }
  // Count keys before the incremental filter so duplicate identities cannot hide
  // in different cursor windows. The database handles the working set, not Node.
  return {
    query: `SELECT * FROM (SELECT *, count(*) OVER (PARTITION BY ${keys}) AS ${q(
      keyCountColumn
    )} FROM (${sql}\n) AS model) AS checked_model${where ? ` WHERE ${where}` : ""} ORDER BY ${order
      .map(n => `${q(n)} ASC`)
      .join(", ")}`,
    values,
    queryParams,
  };
}

export function decodeDelete(value: unknown): boolean {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0" || value === null) return false;
  throw new Error("Delete column must contain booleans or numeric 0/1 values");
}
