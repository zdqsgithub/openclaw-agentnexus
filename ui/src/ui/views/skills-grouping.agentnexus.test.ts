import { describe, expect, it } from "vitest";
import { groupSkills } from "./skills-grouping.js";
import type { SkillStatusEntry } from "../types.js";

function skill(overrides: Partial<SkillStatusEntry>): SkillStatusEntry {
  return {
    name: "Demo",
    description: "Demo skill",
    source: "agentnexus-governed",
    bundled: false,
    filePath: "",
    baseDir: "",
    skillKey: "demo-summary-style",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
    ...overrides,
  };
}

describe("skills grouping", () => {
  it("surfaces AgentNexus governed skills as a dedicated production-governed group", () => {
    const groups = groupSkills([
      skill({ skillKey: "demo-summary-style" }),
      skill({ source: "openclaw-bundled", bundled: true, skillKey: "weather" }),
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "AgentNexus Governed Skills",
      "Built-in Skills",
    ]);
    expect(groups[0]?.skills[0]?.skillKey).toBe("demo-summary-style");
  });
});
