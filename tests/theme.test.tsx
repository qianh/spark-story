import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ThemeSwitch,
  isThemePref,
  resolveTheme,
  themeColor,
} from "../apps/web/theme";

test("主题偏好只接受浅色、深色和跟随系统", () => {
  expect(isThemePref("light")).toBe(true);
  expect(isThemePref("dark")).toBe(true);
  expect(isThemePref("system")).toBe(true);
  expect(isThemePref("auto")).toBe(false);
  expect(isThemePref(null)).toBe(false);
});

test("跟随系统时按系统深色偏好解析实际主题", () => {
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
});

test("浅色与深色使用不同的浏览器主题色", () => {
  expect(themeColor("light")).toBe("#f6f3ee");
  expect(themeColor("dark")).toBe("#141311");
});

test("顶栏主题开关提供浅色、深色和跟随系统三个选项", () => {
  const html = renderToStaticMarkup(<ThemeSwitch />);
  expect(html).toContain('aria-label="外观主题"');
  expect(html).toContain('aria-label="浅色"');
  expect(html).toContain('aria-label="深色"');
  expect(html).toContain('aria-label="跟随系统"');
  expect(html).toContain('role="radio"');
});
