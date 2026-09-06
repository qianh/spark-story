import { Monitor, Moon, Sun } from "lucide-react";
import React, { useEffect, useState } from "react";

export const THEME_KEY = "spark-theme";
export type ThemePref = "light" | "dark" | "system";
export type Theme = "light" | "dark";

const options: {
  id: ThemePref;
  label: string;
  Icon: typeof Sun;
}[] = [
  { id: "light", label: "浅色", Icon: Sun },
  { id: "dark", label: "深色", Icon: Moon },
  { id: "system", label: "跟随系统", Icon: Monitor },
];

export function isThemePref(value: string | null): value is ThemePref {
  return value === "light" || value === "dark" || value === "system";
}

export function readThemePref(): ThemePref {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (isThemePref(value)) return value;
  } catch {}
  return "system";
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref === "light" || pref === "dark") return pref;
  return systemDark ? "dark" : "light";
}

export function themeColor(theme: Theme) {
  return theme === "dark" ? "#141311" : "#f6f3ee";
}

export function applyTheme(
  pref: ThemePref,
  systemDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches,
) {
  const theme = resolveTheme(pref, systemDark);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePref = pref;
  root.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", themeColor(theme));
}

export function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  useEffect(() => {
    applyTheme(pref);
    try {
      localStorage.setItem(THEME_KEY, pref);
    } catch {}
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system", mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);
  return (
    <div className="theme-switch" role="radiogroup" aria-label="外观主题">
      {options.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={pref === id}
          aria-label={label}
          title={label}
          onClick={() => setPref(id)}
        >
          <Icon size={14} strokeWidth={1.8} />
        </button>
      ))}
    </div>
  );
}
