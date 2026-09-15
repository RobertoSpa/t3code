import { describe, expect, it } from "vite-plus/test";

import { isCompleteMermaidFenceAt, isMermaidFenceLanguage } from "./ChatMarkdown";
import { mermaidConfig } from "./MermaidDiagram";

describe("mermaidConfig", () => {
  it("keeps the security fields on every theme", () => {
    for (const theme of ["light", "dark"] as const) {
      const config = mermaidConfig(theme, null);
      expect(config.securityLevel).toBe("strict");
      expect(config.startOnLoad).toBe(false);
      expect(config.suppressErrorRendering).toBe(true);
    }
  });

  it("falls back to a stock theme when no themed element is available", () => {
    const config = mermaidConfig("dark", null);
    expect(config.theme).toBe("dark");
    expect(config.themeVariables).toBeUndefined();
  });

  it("locks the directive-injectable fields against per-diagram overrides", () => {
    const secure = mermaidConfig("dark", null).secure ?? [];
    expect(secure).toContain("securityLevel");
    expect(secure).toContain("themeCSS");
    expect(secure).toContain("fontFamily");
  });

  it("leaves theme and themeVariables unlocked so fence directives still work", () => {
    const secure = mermaidConfig("dark", null).secure ?? [];
    expect(secure).not.toContain("theme");
    expect(secure).not.toContain("themeVariables");
  });
});

describe("isMermaidFenceLanguage", () => {
  it("accepts mermaid and its mmd alias", () => {
    expect(isMermaidFenceLanguage("mermaid")).toBe(true);
    expect(isMermaidFenceLanguage("MERMAID")).toBe(true);
    expect(isMermaidFenceLanguage("mmd")).toBe(true);
  });

  it("rejects every other language", () => {
    expect(isMermaidFenceLanguage("ts")).toBe(false);
    expect(isMermaidFenceLanguage("")).toBe(false);
    expect(isMermaidFenceLanguage("mermaidish")).toBe(false);
  });
});

describe("isCompleteMermaidFenceAt", () => {
  it("accepts a closed fence", () => {
    const text = "```mermaid\ngraph TD;\nA-->B;\n```\n";
    expect(isCompleteMermaidFenceAt(text, 0)).toBe(true);
  });

  it("rejects a fence that is still streaming", () => {
    const text = "```mermaid\ngraph TD;\nA-->B;";
    expect(isCompleteMermaidFenceAt(text, 0)).toBe(false);
  });

  it("reads the fence at the given offset, not the first one in the text", () => {
    const open = "```mermaid\nstill streaming";
    const closed = "```mermaid\ngraph TD;\nA-->B;\n```\n";
    expect(isCompleteMermaidFenceAt(`${closed}${open}`, 0)).toBe(true);
    expect(isCompleteMermaidFenceAt(`${closed}${open}`, closed.length)).toBe(false);
  });

  it("requires the closing marker to match the opening length and character", () => {
    expect(isCompleteMermaidFenceAt("````mermaid\nA\n```\n", 0)).toBe(false);
    expect(isCompleteMermaidFenceAt("````mermaid\nA\n````\n", 0)).toBe(true);
    expect(isCompleteMermaidFenceAt("~~~mermaid\nA\n```\n", 0)).toBe(false);
    expect(isCompleteMermaidFenceAt("~~~mermaid\nA\n~~~\n", 0)).toBe(true);
  });

  it("rejects a non-mermaid fence and a negative offset", () => {
    expect(isCompleteMermaidFenceAt("```ts\nconst a = 1;\n```\n", 0)).toBe(false);
    expect(isCompleteMermaidFenceAt("```mermaid\nA\n```\n", -1)).toBe(false);
  });
});
