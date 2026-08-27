import { describe, expect, it } from "vitest";
import {
  ATTEMPT_LABEL,
  encodePrSessionLabels,
  encodeSessionLabels,
  KIND_LABEL,
  PR_LABEL,
  type PrSessionLabels,
  parsePrSessionLabels,
  parseSessionLabels,
  prSessionFromTranscriptFileName,
  prTranscriptSessionKey,
  REPOSITORY_LABEL,
  repositoryImageSlug,
  type SessionLabels,
  sessionFromTranscriptFileName,
  sessionLayerDockerfile,
  TICKET_LABEL,
  type TranscriptFile,
  transcriptHostDir,
  transcriptSessionKey,
  transcriptsToPrune,
} from "../../src/core/container.js";

const SESSION: SessionLabels = {
  repository: "acme/widgets",
  ticket: 42,
  attempt: 2,
};

const PR_SESSION: PrSessionLabels = {
  repository: "acme/widgets",
  pr: 30,
  kind: "conflict",
};

/** What `docker ps --format '{{.Labels}}'` prints for one container: its whole label set, comma-joined. */
function asDockerLabelsField(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

describe("encodeSessionLabels / parseSessionLabels", () => {
  it("round-trips a session's identity through docker's own comma-joined labels field", () => {
    const raw = asDockerLabelsField(encodeSessionLabels(SESSION));

    expect(parseSessionLabels(raw)).toEqual(SESSION);
  });

  it("ignores labels docker or an operator added alongside ours", () => {
    const raw = `com.docker.compose.project=fleet,${asDockerLabelsField(encodeSessionLabels(SESSION))},maintainer=ops`;

    expect(parseSessionLabels(raw)).toEqual(SESSION);
  });

  it("parses nothing from a container that carries none of our labels", () => {
    expect(
      parseSessionLabels("com.docker.compose.project=fleet"),
    ).toBeUndefined();
  });

  it("parses nothing from an empty labels field", () => {
    expect(parseSessionLabels("")).toBeUndefined();
  });

  it("parses nothing when the repository label is missing", () => {
    const labels = encodeSessionLabels(SESSION);
    delete (labels as Record<string, string | undefined>)[REPOSITORY_LABEL];

    expect(parseSessionLabels(asDockerLabelsField(labels))).toBeUndefined();
  });

  it("parses nothing when the ticket label is not a plain integer", () => {
    const raw = `${REPOSITORY_LABEL}=acme/widgets,${TICKET_LABEL}=not-a-number,${ATTEMPT_LABEL}=2`;

    expect(parseSessionLabels(raw)).toBeUndefined();
  });

  it("parses nothing when the attempt label is not a plain integer", () => {
    const raw = `${REPOSITORY_LABEL}=acme/widgets,${TICKET_LABEL}=42,${ATTEMPT_LABEL}=two`;

    expect(parseSessionLabels(raw)).toBeUndefined();
  });
});

describe("repositoryImageSlug", () => {
  it("lowercases and replaces the slash between owner and repo", () => {
    expect(repositoryImageSlug("acme/widgets")).toBe("acme-widgets");
  });

  it("collapses any run of non-tag-safe characters to one dash", () => {
    expect(repositoryImageSlug("Acme Corp/My--Repo!!")).toBe(
      "acme-corp-my--repo",
    );
  });

  it("trims leading and trailing dashes left over from unsafe characters at the edges", () => {
    expect(repositoryImageSlug("-acme/widgets-")).toBe("acme-widgets");
  });
});

describe("sessionLayerDockerfile", () => {
  it("builds on top of the build-arg image, never a fixed one", () => {
    const content = sessionLayerDockerfile("0.6.0");

    expect(content).toContain("ARG REPO_IMAGE");
    expect(content).toContain(`FROM ${"$"}{REPO_IMAGE}`);
  });

  it("pins border-collie's own install to the given version", () => {
    expect(sessionLayerDockerfile("0.6.0")).toContain("border-collie@0.6.0");
  });

  it("installs Claude Code and gh, the rest of what a session needs", () => {
    const content = sessionLayerDockerfile("0.6.0");

    expect(content).toContain("@anthropic-ai/claude-code");
    expect(content).toContain("apt-get install -y --no-install-recommends gh");
  });
});

describe("transcriptHostDir", () => {
  it("nests a repository's transcript directory owner then name under the root", () => {
    expect(
      transcriptHostDir("/var/lib/border-collie/transcripts", "acme/widgets"),
    ).toBe("/var/lib/border-collie/transcripts/acme/widgets");
  });

  it("strips a trailing slash from the root before joining", () => {
    expect(transcriptHostDir("/root/", "acme/widgets")).toBe(
      "/root/acme/widgets",
    );
  });

  it("rejects a repository that is not a plain owner/repo pair", () => {
    expect(() => transcriptHostDir("/root", "widgets")).toThrow();
    expect(() => transcriptHostDir("/root", "acme/widgets/extra")).toThrow();
  });

  it("rejects a path-traversal segment", () => {
    expect(() => transcriptHostDir("/root", "../etc")).toThrow();
    expect(() => transcriptHostDir("/root", "acme/..")).toThrow();
    expect(() => transcriptHostDir("/root", "acme/../../etc")).toThrow();
  });
});

describe("sessionFromTranscriptFileName", () => {
  it("parses the Ticket and Attempt from a session's stdout transcript file name", () => {
    expect(sessionFromTranscriptFileName("ticket-42-attempt-2.jsonl")).toEqual({
      ticket: 42,
      attempt: 2,
    });
  });

  it("parses the Ticket and Attempt from a session's stderr file name", () => {
    expect(
      sessionFromTranscriptFileName("ticket-42-attempt-2.stderr.log"),
    ).toEqual({ ticket: 42, attempt: 2 });
  });

  it("parses nothing from a file this shape did not write", () => {
    expect(sessionFromTranscriptFileName("declare.jsonl")).toBeUndefined();
    expect(sessionFromTranscriptFileName("notes.txt")).toBeUndefined();
  });
});

describe("transcriptsToPrune", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const now = 30 * DAY;

  function file(name: string, ageMs: number): TranscriptFile {
    return { name, mtimeMs: now - ageMs };
  }

  it("prunes a file older than the retention window", () => {
    const files = [file("ticket-1-attempt-1.jsonl", 15 * DAY)];

    expect(transcriptsToPrune(files, now, 14 * DAY, new Set())).toEqual([
      "ticket-1-attempt-1.jsonl",
    ]);
  });

  it("keeps a file within the retention window", () => {
    const files = [file("ticket-1-attempt-1.jsonl", DAY)];

    expect(transcriptsToPrune(files, now, 14 * DAY, new Set())).toEqual([]);
  });

  it("never prunes the exact session (Ticket and Attempt) still running, no matter its age", () => {
    const files = [file("ticket-1-attempt-1.jsonl", 30 * DAY)];
    const live = new Set([transcriptSessionKey(1, 1)]);

    expect(transcriptsToPrune(files, now, 14 * DAY, live)).toEqual([]);
  });

  it("prunes a settled Attempt's aged-out transcript even while a later Attempt of the same Ticket is running", () => {
    const files = [
      file("ticket-1-attempt-1.jsonl", 20 * DAY),
      file("ticket-1-attempt-1.stderr.log", 20 * DAY),
    ];
    const live = new Set([transcriptSessionKey(1, 2)]);

    expect(transcriptsToPrune(files, now, 14 * DAY, live)).toEqual([
      "ticket-1-attempt-1.jsonl",
      "ticket-1-attempt-1.stderr.log",
    ]);
  });

  it("leaves a file it cannot parse as a session transcript alone, however old", () => {
    const files = [file("notes.txt", 30 * DAY)];

    expect(transcriptsToPrune(files, now, 14 * DAY, new Set())).toEqual([]);
  });

  it("prunes only what is old, across a mixed directory listing", () => {
    const files = [
      file("ticket-1-attempt-1.jsonl", 20 * DAY),
      file("ticket-1-attempt-1.stderr.log", 20 * DAY),
      file("ticket-2-attempt-1.jsonl", HOUR),
    ];

    expect(transcriptsToPrune(files, now, 14 * DAY, new Set())).toEqual([
      "ticket-1-attempt-1.jsonl",
      "ticket-1-attempt-1.stderr.log",
    ]);
  });
});

describe("encodePrSessionLabels / parsePrSessionLabels", () => {
  it("round-trips a PR session's identity through docker's own comma-joined labels field", () => {
    const raw = asDockerLabelsField(encodePrSessionLabels(PR_SESSION));

    expect(parsePrSessionLabels(raw)).toEqual(PR_SESSION);
  });

  it("round-trips a Refinement round the same way as a Conflict Worker", () => {
    const session: PrSessionLabels = { ...PR_SESSION, kind: "refinement" };
    const raw = asDockerLabelsField(encodePrSessionLabels(session));

    expect(parsePrSessionLabels(raw)).toEqual(session);
  });

  it("ignores labels docker or an operator added alongside ours", () => {
    const raw = `com.docker.compose.project=fleet,${asDockerLabelsField(encodePrSessionLabels(PR_SESSION))},maintainer=ops`;

    expect(parsePrSessionLabels(raw)).toEqual(PR_SESSION);
  });

  it("parses nothing from a container that carries none of our labels", () => {
    expect(
      parsePrSessionLabels("com.docker.compose.project=fleet"),
    ).toBeUndefined();
  });

  it("parses nothing from an empty labels field", () => {
    expect(parsePrSessionLabels("")).toBeUndefined();
  });

  it("parses nothing when the repository label is missing", () => {
    const labels = encodePrSessionLabels(PR_SESSION);
    delete (labels as Record<string, string | undefined>)[REPOSITORY_LABEL];

    expect(parsePrSessionLabels(asDockerLabelsField(labels))).toBeUndefined();
  });

  it("parses nothing when the pr label is not a plain integer", () => {
    const raw = `${REPOSITORY_LABEL}=acme/widgets,${PR_LABEL}=not-a-number,${KIND_LABEL}=conflict`;

    expect(parsePrSessionLabels(raw)).toBeUndefined();
  });

  it("parses nothing when the kind label is neither conflict nor refinement", () => {
    const raw = `${REPOSITORY_LABEL}=acme/widgets,${PR_LABEL}=30,${KIND_LABEL}=worker`;

    expect(parsePrSessionLabels(raw)).toBeUndefined();
  });
});

describe("prSessionFromTranscriptFileName", () => {
  it("parses the PR from a Conflict Worker's stdout transcript file name", () => {
    expect(prSessionFromTranscriptFileName("pr-30-conflict.jsonl")).toEqual({
      pr: 30,
      kind: "conflict",
    });
  });

  it("parses the PR from a Conflict Worker's stderr file name", () => {
    expect(
      prSessionFromTranscriptFileName("pr-30-conflict.stderr.log"),
    ).toEqual({ pr: 30, kind: "conflict" });
  });

  it("parses the PR from a Refinement round's stdout transcript file name, dropping the round", () => {
    expect(
      prSessionFromTranscriptFileName("pr-30-refinement-round-2.jsonl"),
    ).toEqual({ pr: 30, kind: "refinement" });
  });

  it("parses the PR from a Refinement round's stderr file name", () => {
    expect(
      prSessionFromTranscriptFileName("pr-30-refinement-round-2.stderr.log"),
    ).toEqual({ pr: 30, kind: "refinement" });
  });

  it("parses nothing from a file this shape did not write", () => {
    expect(
      prSessionFromTranscriptFileName("ticket-1-attempt-1.jsonl"),
    ).toBeUndefined();
    expect(prSessionFromTranscriptFileName("declare.jsonl")).toBeUndefined();
    expect(prSessionFromTranscriptFileName("notes.txt")).toBeUndefined();
  });
});

describe("transcriptsToPrune (PR-scoped sessions)", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const now = 30 * DAY;

  function file(name: string, ageMs: number): TranscriptFile {
    return { name, mtimeMs: now - ageMs };
  }

  it("prunes a Conflict Worker transcript older than the retention window", () => {
    const files = [file("pr-30-conflict.jsonl", 15 * DAY)];

    expect(transcriptsToPrune(files, now, 14 * DAY, new Set())).toEqual([
      "pr-30-conflict.jsonl",
    ]);
  });

  it("keeps a Conflict Worker transcript within the retention window", () => {
    const files = [file("pr-30-conflict.jsonl", DAY)];

    expect(transcriptsToPrune(files, now, 14 * DAY, new Set())).toEqual([]);
  });

  it("never prunes a PR-and-kind session still running, no matter its age", () => {
    const files = [
      file("pr-30-conflict.jsonl", 30 * DAY),
      file("pr-30-conflict.stderr.log", 30 * DAY),
    ];
    const live = new Set([prTranscriptSessionKey(30, "conflict")]);

    expect(transcriptsToPrune(files, now, 14 * DAY, live)).toEqual([]);
  });

  it("prunes a stale Conflict Worker transcript even while a Refinement round for the same PR is running", () => {
    const files = [file("pr-30-conflict.jsonl", 20 * DAY)];
    const live = new Set([prTranscriptSessionKey(30, "refinement")]);

    expect(transcriptsToPrune(files, now, 14 * DAY, live)).toEqual([
      "pr-30-conflict.jsonl",
    ]);
  });

  it("keeps a live Refinement round's transcript regardless of which round is running", () => {
    const files = [file("pr-30-refinement-round-1.jsonl", 20 * DAY)];
    const live = new Set([prTranscriptSessionKey(30, "refinement")]);

    expect(transcriptsToPrune(files, now, 14 * DAY, live)).toEqual([]);
  });

  it("never confuses a Ticket-and-Attempt key with a PR-and-kind key of the same numbers", () => {
    const files = [file("pr-1-conflict.jsonl", 20 * DAY)];
    const live = new Set([transcriptSessionKey(1, 1)]);

    expect(transcriptsToPrune(files, now, 14 * DAY, live)).toEqual([
      "pr-1-conflict.jsonl",
    ]);
  });

  it("prunes only what is old, across a mixed directory of Ticket and PR sessions", () => {
    const files = [
      file("ticket-1-attempt-1.jsonl", 20 * DAY),
      file("pr-30-conflict.jsonl", 20 * DAY),
      file("pr-30-refinement-round-1.jsonl", HOUR),
      file("notes.txt", 30 * DAY),
    ];

    expect(transcriptsToPrune(files, now, 14 * DAY, new Set())).toEqual([
      "ticket-1-attempt-1.jsonl",
      "pr-30-conflict.jsonl",
    ]);
  });
});
