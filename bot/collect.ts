import { App } from "octokit";
import "dotenv/config";
import fs from "node:fs/promises";
import { Octokit } from "octokit";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { Semaphore } from "@core/asyncutil";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as logtape from "@logtape/logtape";
import unzip from "unzip-stream";

await logtape.configure({
  sinks: {
    console: logtape.getConsoleSink({
      formatter: logtape.getAnsiColorFormatter({
        level: "full",
        categoryColor: "cyan",
      }),
    }),
  },
  loggers: [
    {
      category: "app",
      level: "info",
      sinks: ["console"],
    },

    {
      category: ["logtape", "meta"],
      level: "warning",
      sinks: ["console"],
    },
  ],
});

const rootLogger = logtape.getLogger("app");
const mainRepo = "sevenc-nanashi/vv-preview-demo-page";

const [mainRepoOwner, mainRepoName] = mainRepo.split("/");

const getEnv = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
};

const publicDir = `${import.meta.dirname}/../public`;

const app = new App({
  appId: Number.parseInt(getEnv("APP_ID")),
  privateKey: await fs.readFile("./private-key.pem", "utf8"),
  oauth: {
    clientId: getEnv("CLIENT_ID"),
    clientSecret: getEnv("CLIENT_SECRET"),
  },
  Octokit: Octokit.plugin(paginateRest),
});

const appInfo = await app.octokit.request("GET /app");
if (!appInfo.data) {
  throw new Error("Failed to get app info.");
}
rootLogger.info`Running as ${appInfo.data.name}.`;

const { data: installations } = await app.octokit.request(
  "GET /app/installations",
);
const installationId = installations[0].id;

const octokit = await app.getInstallationOctokit(installationId);

const branches = await octokit.paginate("GET /repos/{owner}/{repo}/branches", {
  owner: mainRepoOwner,
  repo: mainRepoName,
});
const filteredBranches = branches.filter(
  (branch) => branch.name.startsWith("project-") || branch.name === "main",
);

const semaphore = new Semaphore(5);

const pullRequests = await octokit.paginate("GET /repos/{owner}/{repo}/pulls", {
  owner: mainRepoOwner,
  repo: mainRepoName,
  state: "open",
});
const downloadTargets = await Promise.all(
  [
    filteredBranches.map(
      (branch) =>
        ({
          type: "branch",
          branch,
          repo: [mainRepoOwner, mainRepoName],
        }) as const,
    ),
    pullRequests.map(
      (pullRequest) =>
        ({
          type: "pullRequest",
          pullRequest,
          repo: [pullRequest.head.repo.owner.login, pullRequest.head.repo.name],
        }) as const,
    ),
  ]
    .flat()
    .map(async (source) => {
      const log = rootLogger.getChild(
        source.type === "branch"
          ? `Branch ${source.branch.name}`
          : `PR #${source.pullRequest.number}`,
      );
      log.info("Checking...");
      const {
        data: { check_runs: checkRuns },
      } = await octokit.request(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        {
          owner: source.repo[0],
          repo: source.repo[1],
          ref:
            source.type === "branch"
              ? source.branch.name
              : source.pullRequest.head.sha,
        },
      );
      const buildPageCheck = checkRuns.find(
        (checkRun) => checkRun.name === "update_pages",
      );
      if (!buildPageCheck) {
        log.info("No build check found");
        return;
      }
      if (!buildPageCheck.details_url) {
        log.info("Build check has no details URL");
        return;
      }
      const runId =
        buildPageCheck.details_url.match(/(?<=\/runs\/)[0-9]+/)?.[0];
      if (!runId) {
        log.error(
          `Failed to extract check run ID from details URL: ${buildPageCheck.details_url}`,
        );
        return;
      }
      const jobId = buildPageCheck.id;
      while (true) {
        const done = await semaphore.lock(async () => {
          const { data: job } = await octokit.request(
            "GET /repos/{owner}/{repo}/actions/jobs/{job_id}",
            {
              owner: source.repo[0],
              repo: source.repo[1],
              job_id: jobId,
            },
          );
          if (job.status === "completed") {
            return true;
          }
          log.info`Waiting for job #${jobId} to complete...`;
          await new Promise((resolve) => setTimeout(resolve, 10000));
          return false;
        });
        if (done) {
          break;
        }
      }
      if (buildPageCheck.conclusion !== "success") {
        log.error("Build check did not succeed");
        return;
      }
      const buildPage = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
        {
          owner: source.repo[0],
          repo: source.repo[1],
          run_id: Number.parseInt(runId),
        },
      );
      const artifact = buildPage.data.artifacts.find(
        (artifact) => artifact.name === "page-dist",
      );
      if (!artifact) {
        log.error("No artifact found");
        return;
      }

      const downloadUrl = artifact.archive_download_url;
      if (!downloadUrl) {
        log.error("No download URL found");
        return;
      }
      log.info`Fetching artifact URL from ${downloadUrl}`;

      const { url: innerDownloadUrl } = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
        {
          owner: source.repo[0],
          repo: source.repo[1],
          artifact_id: artifact.id,
          archive_format: "zip",
        },
      );

      log.info`Downloading artifact from ${innerDownloadUrl}`;
      const response = await fetch(innerDownloadUrl);
      if (!response.ok) {
        log.error`Failed to download artifact: ${response.statusText}`;
        return;
      }
      if (!response.body) {
        log.error("Response has no body");
        return;
      }
      const dirname =
        source.type === "branch"
          ? source.branch.name
          : `pr-${source.pullRequest.number}`;
      const destination = `${publicDir}/${dirname}`;
      log.info`Extracting artifact to ${destination}`;
      await fs.mkdir(destination, { recursive: true });
      await pipeline(
        Readable.fromWeb(response.body),
        unzip.Extract({
          path: destination,
        }),
      );
      log.info("Done.");

      if (source.type === "pullRequest") {
        log.info("Fetching comments...");
        const comments = await octokit.paginate(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
          {
            owner: mainRepoOwner,
            repo: mainRepoName,
            issue_number: source.pullRequest.number,
          },
        );
        const deployInfoMessage = [
          "<!-- deploy -->",
          `プレビュー：<https://sevenc7c.com/vv-preview-demo-bot/${dirname}/>`,
          `更新時点でのコミットハッシュ：[\`${source.pullRequest.head.sha.slice(0, 7)}\`](https://github.com/${
            source.pullRequest.head.repo.full_name
          }/commit/${source.pullRequest.head.sha})`,
        ].join("\n");
        const maybeDeployInfo = comments.find(
          (comment) =>
            comment.user &&
            appInfo.data &&
            comment.user.login === `${appInfo.data.slug}[bot]` &&
            comment.body?.startsWith("<!-- deploy -->"),
        );
        if (!maybeDeployInfo) {
          log.info("Adding deploy info...");
          await octokit.request(
            "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
            {
              owner: mainRepoOwner,
              repo: mainRepoName,
              issue_number: source.pullRequest.number,
              body: deployInfoMessage,
            },
          );
        } else {
          log.info("Updating deploy info...");
          await octokit.request(
            "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
            {
              owner: mainRepoOwner,
              repo: mainRepoName,
              comment_id: maybeDeployInfo.id,
              body: deployInfoMessage,
            },
          );
        }
      }

      return { source, dirname };
    }),
);
const successfulDownloads = downloadTargets.filter(
  (downloadTarget) => downloadTarget !== undefined,
);

await fs.writeFile(
  `${publicDir}/downloads.json`,
  JSON.stringify(successfulDownloads, null, 2),
);
rootLogger.info`Done: ${successfulDownloads.length} downloads / ${downloadTargets.length} attempts.`;
