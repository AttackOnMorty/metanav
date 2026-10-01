#!/usr/bin/env bash
# Fetch GitHub + Azure DevOps state for Meta-Nav.
# Usage: fetch.sh <since-ISO8601-UTC>   -> prints one JSON object to stdout
set -uo pipefail
# jq.exe on Windows ends lines with CRLF; the config reads below strip the CR (a no-op elsewhere)

SINCE="$1"
DIR="$(cd "$(dirname "$0")" && pwd)"
OWNER=$(jq -r '.github_owner' "$DIR/config.json" | tr -d '\r')
RELEASE_DEF=$(jq -r '.ado.release_definition // empty' "$DIR/config.json" | tr -d '\r')
ADO_BASE=$(jq -r '.ado.base_url // empty' "$DIR/config.json" | tr -d '\r')
TODAY=$(date +%Y-%m-%d)

# ---------- GitHub: one GraphQL call ----------
GH_RAW=$(gh api graphql -f query="
{ me: viewer { login }
  review: search(query:\"is:pr is:open review-requested:@me org:$OWNER archived:false\", type:ISSUE, first:30) { nodes { ... on PullRequest {
    number title url createdAt isDraft author { login } repository { name } additions deletions changedFiles
    reviews(last:30) { nodes { author { login } submittedAt } } } } }
  mine: search(query:\"is:pr is:open author:@me org:$OWNER archived:false\", type:ISSUE, first:30) { nodes { ... on PullRequest {
    number title url createdAt isDraft reviewDecision repository { name } headRefName body additions deletions changedFiles
    closingIssuesReferences(first:1) { nodes { number repository { name } } }
    commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
    comments(last:30) { nodes { url author { __typename login } createdAt } }
    reviews(last:30) { nodes { url author { __typename login } createdAt state } }
    reviewThreads(last:50) { nodes { isResolved } } } } }
  issues: search(query:\"is:issue is:open assignee:@me org:$OWNER archived:false\", type:ISSUE, first:50) { nodes { ... on Issue {
    number title url createdAt body repository { name } assignees(first:5) { nodes { login } }
    timelineItems(itemTypes:[ASSIGNED_EVENT], last:10) { nodes { ... on AssignedEvent { createdAt assignee { ... on User { login } } } } }
    comments(last:20) { nodes { url author { login } createdAt body } }
    projectItems(first:3) { nodes {
      status: fieldValueByName(name:\"Status\") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      sprint: fieldValueByName(name:\"Sprint\") { ... on ProjectV2ItemFieldIterationValue { title startDate duration } } } } } } }
}" 2>/dev/null)

if [ -n "$GH_RAW" ] && jq -e '.data.me' >/dev/null 2>&1 <<<"$GH_RAW"; then
  GITHUB=$(jq --arg since "$SINCE" --arg today "$TODAY" '
    .data as $d | $d.me.login as $me |
    def days_since($t): ((now - ($t | fromdateiso8601)) / 86400 | floor);
    # drop a size prefix, e.g. "XL⚠️ ◾ feat: ..." -> "feat: ..."
    def clean: sub("^[^◾]{0,8}◾\\s*"; "");
    # sprint is current when start <= today < start + duration
    def current($sp): $sp != null and ($sp.startDate <= $today)
      and ((($sp.startDate + "T00:00:00Z" | fromdateiso8601) + $sp.duration * 86400 | strftime("%Y-%m-%d")) > $today);

      # PRs, each resolved to its parent PBI. Signals in trust order (same as daily-scrum):
      # the GitHub closing reference, then the "1234-" branch prefix, then a line-anchored keyword.
      # A bare "#N" in prose is never used - it is usually incidental discussion.
      ([ $d.mine.nodes[]
        | [(.comments.nodes[], .reviews.nodes[])] as $fb
        # feedback counts only if it came after both the window start and my own last reply
        | ([$since] + [$fb[] | select(.author.login == $me) | .createdAt] | max) as $after
        | {
        repo: .repository.name, number, title: (.title | clean), url, draft: .isDraft, since: .createdAt,
        size: {files: .changedFiles, added: .additions, removed: .deletions},
        review: (.reviewDecision // "PENDING"),
        ci: (.commits.nodes[0].commit.statusCheckRollup.state // "NONE"),
        unresolved_threads: ([.reviewThreads.nodes[] | select(.isResolved | not)] | length),
        new_feedback: ([$fb[] | select(.author.__typename == "User"
          and .author.login != $me and .createdAt > $after)] | length),
        # the newest of that feedback, to open it directly rather than the top of the PR
        latest_feedback_url: ([$fb[] | select(.author.__typename == "User"
          and .author.login != $me and .createdAt > $after)] | sort_by(.createdAt) | last | .url // null),
        parent: (
          .closingIssuesReferences.nodes[0].number
          // (.headRefName | capture("^(?<n>[0-9]{2,6})-") | .n | tonumber)
          // ((.body // "") | [scan("^\\s*(?:part of|fixes|fixed|closes|closed|resolves|resolved) #([0-9]{2,6})"; "i")] | first | .[0]? | tonumber?)
          // null
        ) } ]) as $prs
      | ([ $d.issues.nodes[] | . as $i | ($i.projectItems.nodes[0] // {}) as $p
        | select(($p.status.name // "") | test("done"; "i") | not)
        | select(current($p.sprint) or (($p.status.name // "") | test("progress|review|block"; "i")))
        | { repo: $i.repository.name, number: $i.number, title: $i.title, url: $i.url,
            # when it became his: the last time it was assigned to him, else when it was opened
            since: ([$i.timelineItems.nodes[] | select(.assignee.login? == $me) | .createdAt] | last // $i.createdAt),
            # what it says: the whole body and its comments (each capped only against pasted logs)
            assignees: [$i.assignees.nodes[].login], body: (($i.body // "")[0:20000]),
            comments: [$i.comments.nodes[] | {by: .author.login, at: .createdAt, url, text: ((.body // "")[0:2000])}],
            status: ($p.status.name // "-"), sprint: ($p.sprint.title // "-"),
            # the day the sprint ends - the PBI deadline, when its board runs sprints and this one is current
            sprint_end: (if current($p.sprint) then (($p.sprint.startDate + "T00:00:00Z" | fromdateiso8601) + $p.sprint.duration * 86400 | strftime("%Y-%m-%d")) else null end) } ]) as $pbis
      | {
      ok: true,
      # A re-request after my review is a new wait: count from my last review, not from PR creation.
      # Drafts stay in: an author may park a PR as a draft while it waits on my review. The run decides whether it matters.
      review_requests: [ $d.review.nodes[]
        | ([.reviews.nodes[] | select(.author.login == $me) | .submittedAt] | max) as $mine
        | {
        repo: .repository.name, number, title: (.title | clean), url, author: .author.login,
        draft: .isDraft, rereview: ($mine != null),
        # how big it is: what a review of it takes
        size: {files: .changedFiles, added: .additions, removed: .deletions},
        since: ([.createdAt, $mine // .createdAt] | max), waiting_days: days_since([.createdAt, $mine // .createdAt] | max) } ],
      # "My work": one row per PBI with its PRs nested; PRs with no PBI on the board sit flat.
      work: (
        [ $pbis[] | . as $b | . + { kind: "pbi", prs: [ $prs[] | select(.repo == $b.repo and .parent == $b.number) ] } ]
        + [ $prs[] | . as $r | select([$pbis[] | select(.repo == $r.repo and .number == $r.parent)] | length == 0)
            | . + { kind: "pr" } ]
      )
    }' <<<"$GH_RAW")
else
  GITHUB='{"ok":false,"error":"gh GraphQL call failed - run `gh auth status`"}'
fi

# ---------- GitHub @mentions since SINCE ----------
# Mentions reach the user only as GitHub notification mail, which the run never reads. The notifications API gives them
# directly; a GET does not mark anything read. Each carries the issue or PR itself - state, assignees, whole body,
# latest comments - so the run can tell whose it is and whether the user has already answered (last_by).
if jq -e '.ok' >/dev/null 2>&1 <<<"$GITHUB"; then
  ME=$(jq -r '.data.me.login' <<<"$GH_RAW")
  MENTIONS=$(gh api "notifications?participating=true&all=true&since=$SINCE&per_page=50" \
      --jq '[.[] | select(.reason == "mention" or .reason == "team_mention")
             | {reason, unread, updated: .updated_at, repo: .repository.full_name, type: .subject.type, title: .subject.title,
                url: (.subject.url // "" | sub("api\\.github\\.com/repos"; "github.com") | sub("/pulls/"; "/pull/")),
                api: .subject.url}]' 2>/dev/null || echo '[]')
  MENTIONS=$(jq -c '.[]' <<<"$MENTIONS" | while IFS= read -r m; do
      api=$(jq -r '.api // empty' <<<"$m" | sed 's#/pulls/#/issues/#')   # a PR is an issue too, for its body and comments
      detail=$( [ -n "$api" ] && gh api "$api" --jq '{state, assignees: [.assignees[].login], author: .user.login, body: ((.body // "")[0:20000])}' 2>/dev/null || echo '{}')
      comments=$( [ -n "$api" ] && gh api "$api/comments?per_page=100" --jq '[.[-20:][] | {by: .user.login, at: .created_at, url: .html_url, text: ((.body // "")[0:2000])}]' 2>/dev/null || echo '[]')
      jq -c --argjson d "${detail:-{\}}" --argjson c "${comments:-[]}" 'del(.api) + $d + {comments: $c, last_by: ($c[-1].by // $d.author)}' <<<"$m"
    done | jq -s --arg me "$ME" 'map(. + {answered: (.last_by == $me)})')
  GITHUB=$(jq --argjson m "${MENTIONS:-[]}" '. + {mentions: $m}' <<<"$GITHUB")
fi

# ---------- Azure DevOps (optional): latest release of one pipeline ----------
# base_url is https://dev.azure.com/<org>/<project>
ADO_ORG="${ADO_BASE%/*}"; ADO_PROJECT="${ADO_BASE##*/}"
[ -n "$RELEASE_DEF" ] && REL_ID=$(az pipelines release list --org "$ADO_ORG" --project "$ADO_PROJECT" \
  --definition-id "$RELEASE_DEF" --top 1 --query "[0].id" -o tsv 2>/dev/null)
if [ -z "$RELEASE_DEF" ]; then
  ADO='{"ok":true,"skipped":true}'
elif [ -n "$REL_ID" ]; then
  ADO=$(az pipelines release show --org "$ADO_ORG" --project "$ADO_PROJECT" --id "$REL_ID" \
      --query "{name:name, created:createdOn, stages:environments[].{name:name,status:status}}" -o json 2>/dev/null \
    | jq --arg url "$ADO_BASE/_releaseProgress?_a=release-pipeline-progress&releaseId=$REL_ID" --arg since "$SINCE" '
      { ok: true, release: (. + { url: $url, is_new: (.created >= $since) }) }')
else
  ADO='{"ok":false,"error":"az pipelines call failed - run `az login`"}'
fi

jq -n --argjson github "$GITHUB" --argjson ado "$ADO" --arg since "$SINCE" \
  '{ since: $since, github: $github, ado: $ado }'
