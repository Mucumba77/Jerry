import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  sql,
  PostgreSQL,
  MySQL,
  MSSQL,
  PLSQL,
  StandardSQL,
} from "@codemirror/lang-sql";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import {
  bracketMatching,
  syntaxHighlighting,
  HighlightStyle,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";

export function currentStatement(
  text: string,
  position: number,
  dialect: string,
) {
  if (
    dialect === "oracle" ||
    dialect === "sqlserver" ||
    /\bDELIMITER\b/i.test(text)
  )
    return text;
  let start = 0,
    quote = "",
    dollar = "",
    block = 0,
    line = false,
    escapeQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      n = text[i + 1];
    if (line) {
      if (c === "\n") line = false;
      continue;
    }
    if (block) {
      if (c === "/" && n === "*") {
        block++;
        i++;
      } else if (c === "*" && n === "/") {
        block--;
        i++;
      }
      continue;
    }
    if (dollar) {
      if (text.startsWith(dollar, i)) {
        i += dollar.length - 1;
        dollar = "";
      }
      continue;
    }
    if (quote) {
      if (c === quote) {
        if (n === quote) i++;
        else quote = "";
      } else if (c === "\\" && escapeQuote) i++;
      continue;
    }
    if (c === "-" && n === "-") {
      line = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      block++;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      escapeQuote =
        dialect === "mysql" ||
        dialect === "mariadb" ||
        (dialect === "postgresql" &&
          c === "'" &&
          /[eE]/.test(text[i - 1] || "") &&
          !/[A-Za-z0-9_]/.test(text[i - 2] || ""));
      continue;
    }
    if (c === "$") {
      const m = text.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        dollar = m[0];
        i += dollar.length - 1;
        continue;
      }
    }
    if (c === ";") {
      if (position <= i + 1) return text.slice(start, i);
      start = i + 1;
    }
  }
  return text.slice(start);
}
export default function Editor({
  value,
  onChange,
  onExecute,
  onExecuteAll,
  dialect = "standard",
  schema = {},
}: {
  value: string;
  onChange: (value: string) => void;
  onExecute: (sql: string) => void;
  onExecuteAll: () => void;
  dialect?: string;
  schema?: Record<string, string[]>;
}) {
  const element = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onExecute, onExecuteAll });
  callbacks.current = { onChange, onExecute, onExecuteAll };
  useEffect(() => {
    if (!element.current) return;
    const language =
      dialect === "postgresql"
        ? PostgreSQL
        : dialect === "mysql" || dialect === "mariadb"
          ? MySQL
          : dialect === "sqlserver"
            ? MSSQL
            : dialect === "oracle"
              ? PLSQL
              : StandardSQL;
    view.current = new EditorView({
      parent: element.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          bracketMatching(),
          sql({ dialect: language, schema }),
          autocompletion(),
          syntaxHighlighting(
            HighlightStyle.define([
              {
                tag: tags.keyword,
                color: "var(--sql-keyword)",
                fontWeight: "600",
              },
              { tag: tags.string, color: "var(--sql-string)" },
              { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
              { tag: tags.number, color: "var(--sql-number)" },
              { tag: tags.operator, color: "var(--accent-text)" },
            ]),
          ),
          keymap.of([
            {
              key: "Mod-Enter",
              run: (view) => {
                const selected = view.state.selection.main;
                callbacks.current.onExecute(
                  selected.empty
                    ? currentStatement(
                        view.state.doc.toString(),
                        selected.head,
                        dialect,
                      )
                    : view.state.sliceDoc(selected.from, selected.to),
                );
                return true;
              },
            },
            {
              key: "Mod-Shift-Enter",
              run: () => {
                callbacks.current.onExecuteAll();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              fontSize: "13px",
              backgroundColor: "var(--surface)",
              color: "var(--text)",
            },
            ".cm-scroller": {
              fontFamily: '"Cascadia Code",Consolas,monospace',
              overflow: "auto",
            },
            ".cm-content": { padding: "20px 0" },
            ".cm-line": { padding: "0 22px" },
            ".cm-gutters": {
              backgroundColor: "var(--surface)",
              color: "var(--muted)",
              border: "none",
              paddingRight: "10px",
            },
            ".cm-activeLine": { backgroundColor: "var(--subtle)" },
            ".cm-activeLineGutter": { backgroundColor: "var(--subtle)" },
            ".cm-cursor": { borderLeftColor: "var(--text)" },
            ".cm-selectionBackground": {
              backgroundColor: "var(--editor-selection)!important",
            },
            ".cm-tooltip": {
              backgroundColor: "var(--surface)",
              color: "var(--text)",
              border: "1px solid var(--line)",
            },
            "&.cm-focused": { outline: "none" },
          }),
          EditorView.contentAttributes.of({ "aria-label": "SQL-Editor" }),
        ],
      }),
    });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, [dialect, JSON.stringify(schema)]);
  useEffect(() => {
    const editor = view.current;
    if (editor && value !== editor.state.doc.toString())
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
      });
  }, [value]);
  return <div className="sql-editor" ref={element} />;
}
