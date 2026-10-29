/// <reference types="vite/client" />
import { useEffect, useState } from "react";

/** Translation catalogs are local static assets; user data is never sent to a translation service. */
export const LANGUAGES = [
  ["de", "Deutsch"],
  ["en", "English"],
  ["fr", "Français"],
  ["es", "Español"],
  ["it", "Italiano"],
  ["ru", "Русский"],
  ["pt", "Português"],
  ["nl", "Nederlands"],
  ["pl", "Polski"],
  ["tr", "Türkçe"],
  ["zh", "中文"],
  ["ja", "日本語"],
  ["ar", "العربية"],
] as const;
const supported = new Set<string>(LANGUAGES.map(([code]) => code));
const catalogs = import.meta.glob<{ default: Record<string, string> }>(
  "./locales/*.json",
);
let language = initialLanguage(),
  catalog: Record<string, string> = {};

function initialLanguage(): string {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("jerry.language");
  } catch {
    /* Storage can be disabled. */
  }
  const preferred = (saved || navigator.language || "de")
    .toLowerCase()
    .split("-")[0];
  return supported.has(preferred) ? preferred : "de";
}
export function locale(): string {
  return language;
}
export function t(source: string): string {
  if (language === "de") return source;
  const translated = catalog[source];
  if (translated == null) return source;
  const leading = source.match(/^\s*/)?.[0] || "";
  const trailing = source.match(/\s*$/)?.[0] || "";
  return (
    (leading && !translated.startsWith(leading) ? leading : "") +
    translated +
    (trailing && !translated.endsWith(trailing) ? trailing : "")
  );
}
/** Format translated messages without interpreting values as markup. */
export function tr(source: string, ...values: unknown[]): string {
  const translated = t(source);
  const expected = [...source.matchAll(/\{(\d+)\}/g)]
    .map((match) => match[1])
    .sort();
  const actual = [...translated.matchAll(/\{(\d+)\}/g)]
    .map((match) => match[1])
    .sort();
  const message = expected.join(",") === actual.join(",") ? translated : source;
  return message.replace(/\{(\d+)\}/g, (_, index: string) =>
    String(values[Number(index)] ?? "—"),
  );
}
async function load(selected: string): Promise<void> {
  const reader = catalogs[`./locales/${selected}.json`];
  const translations =
    selected === "de" || !reader ? {} : (await reader()).default;
  if (language === selected) catalog = translations;
}
export function useI18n() {
  const [selected, setSelected] = useState(language),
    [, update] = useState(0);
  useEffect(() => {
    let active = true;
    document.documentElement.lang = selected;
    document.documentElement.dir = selected === "ar" ? "rtl" : "ltr";
    void load(selected)
      .catch(() => {
        catalog = {};
      })
      .finally(() => {
        if (active) update((value) => value + 1);
      });
    return () => {
      active = false;
    };
  }, [selected]);
  function change(value: string) {
    if (!supported.has(value)) return;
    language = value;
    catalog = {};
    try {
      localStorage.setItem("jerry.language", value);
    } catch {
      /* The current session still works. */
    }
    setSelected(value);
  }
  return { language: selected, setLanguage: change };
}
