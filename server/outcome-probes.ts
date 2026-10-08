import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { OutcomeCheck, WorkOutcome } from "../shared/outcomes.ts";

/** Fixed read-only probes, not arbitrary model-authored shell commands.
 * Guest/VPS checks use an independently authenticated verifier callback;
 * this module must never mistake the host filesystem for a guest's. */
export async function probeOutcome(
  outcome: WorkOutcome,
  check: OutcomeCheck,
  workspace: { cwd: string; host: boolean } | null,
): Promise<{ status: "pass" | "fail" | "pending" | "unavailable"; evidence: string }> {
  if (check.kind === "attestation") return { status: "unavailable", evidence: "A trusted external verifier must record this check" };
  if (check.kind === "http_json") {
    try {
      const response = await fetch(check.url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (response.status === 401 || response.status === 403) return { status: "unavailable", evidence: "The registered verification endpoint requires authorized access" };
      if (!response.ok) return { status: "fail", evidence: "The exact registered endpoint returned HTTP " + response.status };
      const reader = response.body?.getReader();
      if (!reader) return { status: "unavailable", evidence: "The registered endpoint returned no readable body" };
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 256 * 1024) { await reader.cancel(); return { status: "unavailable", evidence: "The verification response exceeds 256 KiB" }; }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      let observed: unknown = body;
      for (const segment of check.pointer.slice(1).split("/")) {
        const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!observed || typeof observed !== "object" || !Object.hasOwn(observed, key)) return { status: "fail", evidence: "The required postcondition field is absent from the exact registered endpoint" };
        observed = (observed as Record<string, unknown>)[key];
      }
      const expected = check.expectedValue ?? outcome.target.revision;
      return { status: observed === expected ? "pass" : "fail", evidence: "Registered endpoint postcondition " + check.pointer + (observed === expected ? " matches the required value" : " does not match the required value") };
    } catch { return { status: "unavailable", evidence: "The exact registered endpoint could not be checked; redirects and differently configured fallback paths are not accepted" }; }
  }
  if (check.kind === "github_pr") {
    return await new Promise(resolveAnswer => {
      execFile("gh", ["pr", "view", String(check.pullRequest), "--repo", check.repository, "--json", "headRefOid,statusCheckRollup"], { timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) return resolveAnswer({ status: "unavailable", evidence: "The registered PR's actual head and checks could not be read" });
        try {
          const result = JSON.parse(stdout) as { headRefOid?: unknown; statusCheckRollup?: Array<{ name?: string; context?: string; conclusion?: string; state?: string; status?: string }> };
          if (result.headRefOid !== outcome.target.revision) return resolveAnswer({ status: "fail", evidence: "The live PR head does not match the registered revision" });
          const states = check.requiredChecks.map(name => result.statusCheckRollup?.find(row => row.name === name || row.context === name));
          const bad = states.some(row => row && (row.conclusion ? !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(row.conclusion) && row.status === "COMPLETED" : ["FAILURE", "ERROR"].includes(row.state ?? "")));
          if (bad) return resolveAnswer({ status: "fail", evidence: "A required check failed on the exact registered PR head" });
          if (states.some(row => !row || (row.conclusion !== "SUCCESS" && row.state !== "SUCCESS"))) return resolveAnswer({ status: "pending", evidence: "Required checks are missing, pending or not successful on the exact current PR head" });
          return resolveAnswer({ status: "pass", evidence: "Live PR head matches; every registered required check reports SUCCESS" });
        } catch { return resolveAnswer({ status: "unavailable", evidence: "The PR check response was not usable" }); }
      });
    });
  }
  if (!workspace?.host) return { status: "unavailable", evidence: "This check needs a host workspace or a trusted verifier for the actual guest resource" };
  let root: string;
  try { root = realpathSync(workspace.cwd); }
  catch { return { status: "unavailable", evidence: "The registered working folder is unavailable" }; }
  if (check.kind === "git_head") {
    return await new Promise(resolveAnswer => {
      execFile("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 10_000, maxBuffer: 4_096, windowsHide: true }, (error, stdout) => {
        if (error) return resolveAnswer({ status: "unavailable", evidence: "The current revision could not be read from the registered workspace" });
        const actual = stdout.trim();
        resolveAnswer({ status: actual === outcome.target.revision ? "pass" : "fail", evidence: "Registered workspace HEAD: " + actual + "; required: " + outcome.target.revision });
      });
    });
  }
  if (isAbsolute(check.path) || /^[A-Za-z]:/.test(check.path) || check.path.includes("\0") || check.path.split(/[\\/]/).includes("..")) return { status: "unavailable", evidence: "Artifact paths must stay relative to the registered working folder" };
  const file = resolve(root, check.path);
  let handle: number | undefined;
  try {
    const canonical = realpathSync(file);
    const within = relative(root, canonical);
    if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within) || lstatSync(file).isSymbolicLink()) return { status: "unavailable", evidence: "The artifact path leaves the registered working folder or is a symlink" };
    handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(handle);
    if (!before.isFile() || before.size > 16 * 1024 * 1024) return { status: "unavailable", evidence: "The artifact must be a regular file no larger than 16 MiB" };
    const digest = createHash("sha256").update(readFileSync(handle)).digest("hex");
    const after = fstatSync(handle);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || realpathSync(file) !== canonical) return { status: "unavailable", evidence: "The artifact changed while being checked; retry the same current target" };
    return { status: digest === check.sha256 ? "pass" : "fail", evidence: "Registered artifact SHA256: " + digest + "; required: " + check.sha256 };
  } catch {
    return { status: "fail", evidence: "The required artifact is not readable in the registered working folder" };
  } finally { if (handle !== undefined) closeSync(handle); }
}
