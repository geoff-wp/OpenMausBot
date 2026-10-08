import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeOutcome } from "./outcome-probes.ts";
import type { WorkOutcome } from "../shared/outcomes.ts";

const folders: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const folder = () => { const value = mkdtempSync(join(tmpdir(), "outcome-probes-")); folders.push(value); return value; };
const outcome = { target: { revision: "actual-current-revision", environment: "actual-live-path" } } as WorkOutcome;

describe("independent postcondition probes", () => {
  it("requires the actual candidate revision and a clean checkout, including staged and untracked files", async () => {
    const root = folder();
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "--quiet"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Outcome fixture");
    writeFileSync(join(root, "candidate.txt"), "registered candidate");
    git("add", "candidate.txt"); git("-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Registered candidate");
    const revision = git("rev-parse", "HEAD").trim();
    const registered = { ...outcome, target: { ...outcome.target, revision } };
    const check = { id: "candidate", kind: "git_head" as const, description: "Exact tested candidate", maxAgeMs: 5_000 };
    expect((await probeOutcome(outcome, check, { cwd: root, host: true })).status).toBe("fail");
    expect((await probeOutcome(registered, check, { cwd: root, host: true })).status).toBe("pass");
    writeFileSync(join(root, "candidate.txt"), "unverified changes");
    expect((await probeOutcome(registered, check, { cwd: root, host: true })).status).toBe("fail");
    git("add", "candidate.txt");
    expect((await probeOutcome(registered, check, { cwd: root, host: true })).status).toBe("fail");
    git("restore", "--staged", "--worktree", "candidate.txt");
    writeFileSync(join(root, "extra.txt"), "unverified new file");
    expect((await probeOutcome(registered, check, { cwd: root, host: true })).status).toBe("fail");
    unlinkSync(join(root, "extra.txt"));
    expect((await probeOutcome(registered, check, { cwd: root, host: true })).status).toBe("pass");
    for (const flag of ["assume-unchanged", "skip-worktree"]) {
      git("update-index", "--" + flag, "candidate.txt");
      writeFileSync(join(root, "candidate.txt"), "hidden unverified changes");
      expect(git("status", "--porcelain").trim()).toBe("");
      expect((await probeOutcome(registered, check, { cwd: root, host: true })).status).toBe("fail");
      git("update-index", "--no-" + flag, "candidate.txt");
      git("restore", "--worktree", "candidate.txt");
    }
  });
  it("checks the actual bytes in the registered task folder, not a model claim or another folder", async () => {
    const root = folder(); const other = folder(); const content = "required artifact";
    const check = { id: "artifact", kind: "artifact" as const, description: "Expected output", path: "artifact.txt", sha256: createHash("sha256").update(content).digest("hex"), maxAgeMs: 5_000 };
    writeFileSync(join(other, "artifact.txt"), content);
    expect((await probeOutcome(outcome, check, { cwd: root, host: true })).status).toBe("fail");
    writeFileSync(join(root, "artifact.txt"), "wrong bytes");
    expect((await probeOutcome(outcome, check, { cwd: root, host: true })).status).toBe("fail");
    writeFileSync(join(root, "artifact.txt"), content);
    expect((await probeOutcome(outcome, check, { cwd: root, host: true })).status).toBe("pass");
    expect((await probeOutcome(outcome, check, { cwd: root, host: false })).status).toBe("unavailable");
  });

  it("does not escape the task folder through traversal or a symlink", async () => {
    const root = folder(); const outside = folder(); writeFileSync(join(outside, "private.txt"), "outside");
    const check = { id: "artifact", kind: "artifact" as const, description: "Expected output", path: "../private.txt", sha256: "a".repeat(64), maxAgeMs: 5_000 };
    expect((await probeOutcome(outcome, check, { cwd: root, host: true })).status).toBe("unavailable");
    if (process.platform !== "win32") {
      symlinkSync(join(outside, "private.txt"), join(root, "link.txt"));
      expect((await probeOutcome(outcome, { ...check, path: "link.txt" }, { cwd: root, host: true })).status).toBe("unavailable");
      mkdirSync(join(root, "nested")); symlinkSync(outside, join(root, "nested", "outside"));
      expect((await probeOutcome(outcome, { ...check, path: "nested/outside/private.txt" }, { cwd: root, host: true })).status).toBe("unavailable");
    }
  });

  it("reads the exact registered user-facing path and rejects a differently configured standalone check", async () => {
    let liveRevision = "wrong-live-revision";
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url!); res.setHeader("content-type", "application/json");
      if (req.url === "/redirect") { res.writeHead(302, { location: "/standalone" }); res.end(); return; }
      res.end(JSON.stringify({ source_sha: req.url === "/standalone" ? outcome.target.revision : liveRevision }));
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const check = { id: "live", kind: "http_json" as const, description: "Actual deployed path", url: "http://127.0.0.1:" + port + "/live?actual_config=true", pointer: "/source_sha", maxAgeMs: 5_000 };
    expect((await probeOutcome(outcome, check, null)).status).toBe("fail");
    expect(seen).toEqual(["/live?actual_config=true"]);
    liveRevision = outcome.target.revision;
    expect((await probeOutcome(outcome, check, null)).status).toBe("pass");
    expect((await probeOutcome(outcome, { ...check, url: "http://127.0.0.1:" + port + "/redirect" }, null)).status).toBe("unavailable");
    expect(seen.includes("/standalone")).toBe(false);
  });
});
