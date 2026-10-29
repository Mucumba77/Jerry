import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { snippet } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

export type CompletionTable = { name: string; schema: string };
export type CompletionCatalog = {
  identity: string;
  schema: string;
  quote: string;
  storesUpperCase: boolean;
  storesLowerCase: boolean;
  dialect: string;
  tables: CompletionTable[];
  loadColumns: (table: CompletionTable) => Promise<string[]>;
};

const commonFunctions = [
  "ABS",
  "AVG",
  "CAST",
  "COALESCE",
  "COUNT",
  "LOWER",
  "MAX",
  "MIN",
  "NULLIF",
  "ROUND",
  "SUM",
  "UPPER",
];
const dialectFunctions: Record<string, string[]> = {
  standard: ["LENGTH", "SUBSTRING", "TRIM"],
  postgresql: [
    "LENGTH",
    "SUBSTRING",
    "TRIM",
    "DATE_TRUNC",
    "NOW",
    "STRING_AGG",
  ],
  mysql: [
    "LENGTH",
    "SUBSTRING",
    "TRIM",
    "DATE_FORMAT",
    "GROUP_CONCAT",
    "IFNULL",
    "NOW",
  ],
  mariadb: [
    "LENGTH",
    "SUBSTRING",
    "TRIM",
    "DATE_FORMAT",
    "GROUP_CONCAT",
    "IFNULL",
    "NOW",
  ],
  oracle: ["LENGTH", "SUBSTR", "TRIM", "DECODE", "NVL", "TO_CHAR", "TO_DATE"],
  sqlserver: [
    "SUBSTRING",
    "TRIM",
    "DATEADD",
    "DATEDIFF",
    "GETDATE",
    "ISNULL",
    "LEN",
  ],
};
const keywords = new Set(
  "all alter and as asc by case create delete desc distinct drop else end from group having in insert into join limit not null on or order select set table then union update values view when where".split(
    " ",
  ),
);

// Quoted names and unquoted names are parsed without using user text as a regular expression.
const identifier =
  '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[(?:[^\\]]|\\]\\])*\\]|[\\p{L}_$#][\\p{L}\\p{N}_$#]*)';
const qualified = new RegExp(
  `(${identifier})(?:\\s*\\.\\s*(${identifier}))?\\s*\\.\\s*([\\p{L}\\p{N}_$#]*|"[^"]*|\u0060[^\u0060]*|\\[[^\\]]*)$`,
  "u",
);
const word = /[\p{L}_$#][\p{L}\p{N}_$#]*$/u;

function unquote(value: string): { name: string; quoted: boolean } {
  const first = value[0],
    last = value[value.length - 1];
  if (
    (first === '"' && last === '"') ||
    (first === "`" && last === "`") ||
    (first === "[" && last === "]")
  ) {
    const close = first === "[" ? "]" : first;
    return {
      name: value
        .slice(1, -1)
        .split(close + close)
        .join(close),
      quoted: true,
    };
  }
  return { name: value, quoted: false };
}

function matches(
  actual: string,
  requested: { name: string; quoted: boolean },
  catalog?: CompletionCatalog,
) {
  if (requested.quoted) return actual === requested.name;
  if (catalog?.storesUpperCase) return actual === requested.name.toUpperCase();
  if (catalog?.storesLowerCase) return actual === requested.name.toLowerCase();
  return actual.toLowerCase() === requested.name.toLowerCase();
}

function identifierNodes(
  node: SyntaxNode,
  state: CompletionContext["state"],
): string[] {
  if (node.name !== "CompositeIdentifier")
    return [state.sliceDoc(node.from, node.to)];
  const parts: string[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling)
    if (child.name === "Identifier" || child.name === "QuotedIdentifier")
      parts.push(state.sliceDoc(child.from, child.to));
  return parts;
}

function isIdentifier(node: SyntaxNode | null): node is SyntaxNode {
  return (
    !!node &&
    ["Identifier", "QuotedIdentifier", "CompositeIdentifier"].includes(
      node.name,
    )
  );
}

/** Resolves common FROM/JOIN/UPDATE/INTO aliases in the current statement, including aliases after the cursor. */
function resolveAlias(
  context: CompletionContext,
  requested: { name: string; quoted: boolean },
): {
  table: { name: string; quoted: boolean };
  schema?: { name: string; quoted: boolean };
} | null {
  let statement: SyntaxNode | null = syntaxTree(context.state).resolveInner(
    context.pos,
    -1,
  );
  while (statement && statement.name !== "Statement")
    statement = statement.parent;
  if (!statement) return null;
  for (let node = statement.firstChild; node; node = node.nextSibling) {
    if (
      node.name !== "Keyword" ||
      !/^(from|join|update|into)$/i.test(
        context.state.sliceDoc(node.from, node.to),
      )
    )
      continue;
    const table = node.nextSibling;
    if (!isIdentifier(table)) continue;
    let alias = table.nextSibling;
    if (
      alias?.name === "Keyword" &&
      /^as$/i.test(context.state.sliceDoc(alias.from, alias.to))
    )
      alias = alias.nextSibling;
    if (!isIdentifier(alias) || alias.name === "CompositeIdentifier") continue;
    if (
      !matches(
        unquote(context.state.sliceDoc(alias.from, alias.to)).name,
        requested,
      )
    )
      continue;
    const parts = identifierNodes(table, context.state).map(unquote);
    return {
      table: parts[parts.length - 1],
      schema: parts.length > 1 ? parts[parts.length - 2] : undefined,
    };
  }
  return null;
}

function safeIdentifier(name: string, catalog: CompletionCatalog): string {
  const mustQuote =
    !/^[\p{L}_][\p{L}\p{N}_$]*$/u.test(name) ||
    keywords.has(name.toLowerCase()) ||
    (catalog.storesUpperCase && name !== name.toUpperCase()) ||
    (catalog.storesLowerCase && name !== name.toLowerCase()) ||
    (!catalog.storesUpperCase &&
      !catalog.storesLowerCase &&
      /[a-z]/.test(name) &&
      /[A-Z]/.test(name));
  const open = catalog.quote.trim();
  if (!mustQuote || !open) return name;
  const close = open === "[" ? "]" : open;
  return open + name.split(close).join(close + close) + close;
}

function identifierOption(
  name: string,
  catalog: CompletionCatalog,
  type: string,
  typedQuote?: string,
): Completion {
  if (!typedQuote)
    return { label: name, type, apply: safeIdentifier(name, catalog) };
  const close = typedQuote === "[" ? "]" : typedQuote;
  const quoted = typedQuote + name.split(close).join(close + close) + close;
  return { label: quoted, type, apply: quoted };
}

function inLiteralOrComment(context: CompletionContext): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(context.state).resolveInner(
      context.pos,
      -1,
    );
    node;
    node = node.parent
  )
    if (["String", "LineComment", "BlockComment"].includes(node.name))
      return true;
  return false;
}

/** A metadata-driven completion source. Columns are fetched only for a resolved table. */
export function sqlCompletionSource(
  getCatalog: () => CompletionCatalog,
): CompletionSource {
  return async (context): Promise<CompletionResult | null> => {
    if (inLiteralOrComment(context)) return null;
    const catalog = getCatalog();
    const identity = catalog.identity;
    // Limit per-keystroke work for very large scripts while keeping room for qualified identifiers.
    const before = context.state.sliceDoc(
      Math.max(0, context.pos - 4096),
      context.pos,
    );
    const match = qualified.exec(before);
    if (match) {
      const first = unquote(match[1]);
      const second = match[2] ? unquote(match[2]) : null;
      const partial = match[3] || "";
      const typedQuote = /^["`\[]/.test(partial) ? partial[0] : undefined;
      const from = context.pos - partial.length;
      const closing = typedQuote === "[" ? "]" : typedQuote;
      const to =
        closing &&
        context.state.sliceDoc(context.pos, context.pos + 1) === closing
          ? context.pos + 1
          : undefined;
      if (!second && matches(catalog.schema, first, catalog)) {
        return {
          from,
          to,
          options: catalog.tables
            .filter((t) => t.schema === catalog.schema)
            .map((t) => identifierOption(t.name, catalog, "type", typedQuote)),
        };
      }
      const alias = !second ? resolveAlias(context, first) : null;
      const wanted = alias ? alias.table : second || first;
      const schema = second ? first : alias?.schema;
      if (schema && !matches(catalog.schema, schema, catalog)) return null;
      const candidates = catalog.tables.filter(
        (t) => t.schema === catalog.schema && matches(t.name, wanted, catalog),
      );
      const exact = candidates.find((t) => t.name === wanted.name);
      const table =
        exact || (candidates.length === 1 ? candidates[0] : undefined);
      if (!table) return null;
      let columns: string[];
      try {
        columns = await catalog.loadColumns(table);
      } catch {
        return null;
      }
      if (context.aborted || getCatalog().identity !== identity) return null;
      return {
        from,
        to,
        options: columns.map((name) =>
          identifierOption(name, catalog, "property", typedQuote),
        ),
      };
    }
    const matchWord = word.exec(before);
    if (!matchWord && !context.explicit) return null;
    const from = matchWord ? context.pos - matchWord[0].length : context.pos;
    const functions = [
      ...commonFunctions,
      ...(dialectFunctions[catalog.dialect] || dialectFunctions.standard),
    ];
    const options: Completion[] = [
      ...catalog.tables
        .filter((t) => t.schema === catalog.schema)
        .map((t) => identifierOption(t.name, catalog, "type")),
      ...functions.map((name) => ({
        label: name,
        type: "function",
        apply: snippet(name + "(${})"),
      })),
    ];
    return { from, options, validFor: /^[\p{L}\p{N}_$#]*$/u };
  };
}
