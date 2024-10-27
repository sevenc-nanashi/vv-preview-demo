import { createResource, For } from "solid-js";
import type { Endpoints } from "@octokit/types";
import "./App.css";
type Branch =
  Endpoints["GET /repos/{owner}/{repo}/branches"]["response"]["data"][0];
type PullRequest =
  Endpoints["GET /repos/{owner}/{repo}/pulls"]["response"]["data"][0];

async function fetchDownload() {
  const response = await fetch(`${import.meta.env.BASE_URL}downloads.json`);
  if (!response.ok) {
    throw new Error("Failed to fetch download infos");
  }
  return await response.json();
}

function App() {
  const [downloads] = createResource<
    {
      source:
        | {
            type: "branch";
            branch: Branch;
          }
        | {
            type: "pullRequest";
            pullRequest: PullRequest;
          };
      dirname: string;
    }[]
  >(fetchDownload);

  return (
    <>
      <div>
        <h1>Voicevox Preview Bot Demo</h1>

        <For each={downloads()}>
          {(download) => {
            return (
              <a href={`${import.meta.env.BASE_URL}${download.dirname}/index.html`}>
                <button type="button">
                  {download.source.type === "branch"
                    ? `Branch ${download.source.branch.name}`
                    : `PR #${download.source.pullRequest.number}`}
                </button>
              </a>
            );
          }}
        </For>
      </div>
    </>
  );
}

export default App;
