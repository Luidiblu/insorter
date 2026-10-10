import { describe, expect, test } from "bun:test";
import { csvRow, diffAccounts, relationOf, suggest, validateGroups, type Snapshot } from "./lib";

describe("relationOf", () => {
  test("mutual beats one-directional flags and pending", () => {
    expect(relationOf({ you_follow: true, follows_you: true, pending_request: true })).toBe("mutual");
    expect(relationOf({ you_follow: true, follows_you: false, pending_request: false })).toBe("you_follow");
    expect(relationOf({ you_follow: false, follows_you: true, pending_request: false })).toBe("follows_you");
    expect(relationOf({ you_follow: false, follows_you: false, pending_request: true })).toBe("pending");
    expect(relationOf({ you_follow: false, follows_you: false, pending_request: false })).toBe("none");
  });
});

describe("suggest", () => {
  const groups = ["Group 1", "Group 2"];
  test("ignores diacritics and matches long keywords inside handles", () => {
    expect(suggest({ "Group 1": ["Smith"] }, groups, ["jsmith_", "John"])).toEqual({ group: "Group 1", hits: ["Smith"] });
    expect(suggest({ "Group 1": ["zürich"] }, groups, ["ana", "Zurich, CH"])).toEqual({ group: "Group 1", hits: ["zürich"] });
  });
  test("short keywords only match whole words", () => {
    expect(suggest({ "Group 2": ["dev"] }, groups, ["devourer", ""])).toBeNull();
    expect(suggest({ "Group 2": ["dev"] }, groups, ["ana", "backend dev"])).toEqual({ group: "Group 2", hits: ["dev"] });
  });
  test("picks the group with more distinct hits; ties keep group order", () => {
    const kw = { "Group 1": ["smith"], "Group 2": ["smith", "engineer"] };
    expect(suggest(kw, groups, ["john.smith", "Engineer"])?.group).toBe("Group 2");
    expect(suggest({ "Group 1": ["smith"], "Group 2": ["smith"] }, groups, ["john.smith", ""])?.group).toBe("Group 1");
  });
  test("keywords of unknown groups are ignored", () => {
    expect(suggest({ Other: ["smith"] }, groups, ["john.smith", ""])).toBeNull();
  });
});

describe("validateGroups", () => {
  test("rejects duplicates, empties, long names and more than nine groups", () => {
    expect(validateGroups(["A", "a "], ["Trash"], {})).toBe("duplicate group names");
    expect(validateGroups(["A", ""], ["Trash"], {})).toBe("a group name is empty or longer than 40 characters");
    expect(validateGroups(Array.from({ length: 10 }, (_, i) => "G" + i), ["Trash"], {})).toBe("at most 9 groups (keys 1–9)");
    expect(validateGroups("x", [], {})).toBe("invalid format");
  });
  test("normalizes names and keeps keywords only for existing groups, deduplicated and lowercased", () => {
    const out = validateGroups(["  Close   friends "], ["Trash"], { "Close friends": ["Zürich", "zürich", " CH "], Ghost: ["x"] });
    expect(out).toEqual({ buckets: ["Close friends"], special: ["Trash"], keywords: { "Close friends": ["zürich", "ch"] } });
  });
});

describe("csvRow", () => {
  test("quotes cells with commas, quotes or newlines and keeps the rest bare", () => {
    expect(csvRow(["a", 1, true, null, 'say "hi"', "x,y", "l1\nl2"])).toBe('a,1,true,,"say ""hi""","x,y","l1\nl2"');
  });
});

describe("diffAccounts", () => {
  const s = (pk: string, f: Partial<Snapshot>): Snapshot => ({ pk, username: "u" + pk, full_name: "", you_follow: false, follows_you: false, pending_request: false, ...f });
  test("classifies lost and gained relationships in both directions", () => {
    const prev = [s("1", { follows_you: true }), s("2", { you_follow: true }), s("3", { follows_you: true, you_follow: true }), s("4", { follows_you: true })];
    const next = [s("1", { follows_you: false }), s("2", { you_follow: true, follows_you: true }), s("5", { you_follow: true }), s("6", { pending_request: true })];
    const d = diffAccounts(prev, next);
    expect(d.unfollowed_you.map(a => a.pk)).toEqual(["1", "3", "4"]);
    expect(d.you_unfollowed.map(a => a.pk)).toEqual(["3"]);
    expect(d.new_followers.map(a => a.pk)).toEqual(["2"]);
    expect(d.you_followed.map(a => a.pk)).toEqual(["5"]);
    expect(d.new_requests.map(a => a.pk)).toEqual(["6"]);
  });
  test("an unchanged graph yields empty lists", () => {
    const same = [s("1", { follows_you: true, you_follow: true })];
    expect(Object.values(diffAccounts(same, same)).every(l => l.length === 0)).toBe(true);
  });
});
