const TOPICS = {
  start: "start init launch delegate queue batch starten",
  models: "model models kind effort opus sonnet claude codex copilot budget manual autonomous modell",
  quota: "quota limit limits exhausted switch wechsel wechseln",
  stop: "stop cancel unfinished abandon stoppen abbrechen",
  close: "close cleanup finish archive schliessen aufraumen",
  config: "config configuration subproject nested snapshot projekt",
  wait: "wait watch notification notifications callback hook hooks polling warten uberwachen",
  trust: "trust permission permissions approval dialog approve berechtigung freigabe",
  worktree: "worktree worktrees busy isolation conflict conflicts checkout move",
  review: "review accept result results inbox proof abnahme",
};
const FILLER = new Set("please how do i can to a an the my with for agent agents worker workers session sessions run herdr axi wie kann ich bitte ein eine einen der die das und".split(" "));

export function guide(args = []) {
  const full = fullGuide();
  if (!args.length) return full;
  const query = args.join(" ");
  const words = query.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => !FILLER.has(word)) ?? [];
  const fallback = { topics: Object.keys(TOPICS), examples: ["herdr-axi guide start opus", "herdr-axi guide quota switch", "herdr-axi guide wait notification"] };
  if (query.length > 200 || words.length > 8) return { error: "Guide query limit: 200 characters, 8 meaningful words", code: "GUIDE_QUERY_LIMIT", ...fallback };
  let matches = Object.entries(TOPICS).filter(([, aliases]) => aliases.split(" ").some((word) => words.includes(word))).map(([topic]) => topic);
  if (matches.includes("start") || matches.includes("quota")) matches = matches.filter((topic) => topic !== "models");
  if (!matches.length) return { error: `Unknown guide topic; topics: ${fallback.topics.join(", ")}`, code: "UNKNOWN_GUIDE_TOPIC", ...fallback };
  if (matches.length > 1) return { error: "Multiple topics; choose one recipe", code: "AMBIGUOUS_GUIDE_TOPIC", matches: matches.slice(0, 3).map((topic) => ({ topic, help: `herdr-axi guide ${topic}` })), examples: matches.slice(0, 3).map((topic) => `herdr-axi guide ${topic}`), ...(matches.length > 3 ? { more: matches.length - 3 } : {}) };
  const topic = matches[0];
  if (words.includes("opus") && words.includes("sonnet")) return { error: "Choose one model: opus or sonnet", code: "AMBIGUOUS_GUIDE_TOPIC", examples: ["herdr-axi guide start opus", "herdr-axi guide start sonnet"] };
  const choice = words.includes("sonnet") ? full.models.choice.replace("claude-opus-5", "sonnet") : full.models.choice;
  const recovery = (...states) => full.recovery.filter((row) => states.includes(row.when));
  const recipes = {
    start: { placeholders: full.placeholders, start: full.start.map((command) => words.includes("opus") || words.includes("sonnet") ? command.replace("--role implementer", choice) : command), batch: full.batch, policy: full.models.policy, mode: full.models.mode, budget: full.models.budget, rules: full.rules.slice(0, 3), next: full.waiting.work },
    models: { ...full.models, choice },
    quota: { placeholders: full.placeholders, recovery: recovery("quota"), retry: "Interrupted switch: herdr-axi run switch TASK; same checkpoint, no new run" },
    stop: { placeholders: full.placeholders, recovery: recovery("stop unfinished"), safety: full.rules[1] },
    close: { placeholders: full.placeholders, recovery: recovery("accepted worker", "all tasks resolved"), safety: full.rules[1], distinction: "Accepted + closed is NOT cancelled. Requested abort: run cancel before acceptance" },
    config: { config: full.models.config, identity: "Git worktree root identity retained; nearest whole file, no ancestor merge", choice: full.models.choice, policy: full.models.policy },
    wait: full.waiting,
    trust: { placeholders: full.placeholders, recovery: recovery("permission/trust", "approved UI answer"), next: "After approved startup: herdr-axi run recover PANE_ID; no blind prompt resend" },
    worktree: { placeholders: full.placeholders, rule: full.rules[2], recovery: recovery("worktree busy") },
    review: { placeholders: full.placeholders, recovery: recovery("review ready"), report: "herdr-axi run inbox once if not already delivered by watch; inspect checks before acceptance", next: "Changes needed: revise BEFORE accept; after acceptance queue a new task with same role/cwd to reuse. No repeated report fetch" },
  };
  return { topic, ...recipes[topic] };
}

function fullGuide() {
  return {
    placeholders: "PROJECT_DIR, RUN_DIR, WORKTREE, TASK, AREA, PANE_ID: replace; RUN_DIR from init",
    start: [
      "herdr-axi run init --project PROJECT_DIR",
      'export HERDR_AXI_RUN=\'RUN_DIR\'; herdr-axi run queue TASK --role implementer --cwd WORKTREE --area AREA --prompt "task; owned files; checks" --start',
    ],
    batch: "Omit --start; queue bounded independent tasks, then herdr-axi run next once",
    models: {
      choice: "--role implementer --kind claude --model claude-opus-5 --effort high",
      policy: "Queue override; role access/native-child policy preserved; no config edit or new run",
      mode: "Managed autonomous mode; no manual-mode or arbitrary native-flag override; trust prompts still possible",
      budget: "App/API model budget separate from coding-worker subscriptions; respect each explicit scope",
      config: "Nearest .herdr-axi.json through worktree root; snapshot at init; selected path returned",
    },
    rules: [
      "No fleet/layout/raw-herdr/run.json preflight; no repeated help discovery",
      "Owned pane IDs only; never names, owner pane, or global-discovery targets",
      "Concurrent writers: isolated worktrees first; HEAD snapshots omit dirty/untracked changes",
      "Short inline task/checks; no repository task/state documents; concise TOON results",
      "Bounded roles/capacity; phase funnel explore -> build -> integrate -> verify -> fix",
    ],
    waiting: {
      work: "Continue independent work; no inbox/read polling",
      watch: "herdr-axi watch --timeout-ms 1800000",
      delivery: "One tracked background watch only with verified completion callback; retain job handle",
      fallback: "No callback: independent work first; blocking watch only when dependent",
      hooks: "Hooks save results; no guaranteed push to orchestrator; detached PID/toast is not a callback",
      result: "Watch includes review reports; act on returned help; no duplicate inbox fetch; timeout != completion",
    },
    recovery: [
      { when: "worktree busy", command: "herdr-axi run move TASK --cwd WORKTREE --area AREA", rule: "Existing isolated checkout; verify required changes, then run next once" },
      { when: "permission/trust", command: "herdr-axi read PANE_ID --raw", rule: "Inspect exact dialog; authorized answer only; no automatic approval" },
      { when: "approved UI answer", command: "herdr-axi dispatch PANE_ID --keys KEY", rule: "KEY from inspected dialog; then follow startup recovery help" },
      { when: "quota", command: "herdr-axi run switch PANE_ID --kind claude --model claude-opus-5 --effort high", rule: "Different available provider; explicit cost authority; retained partial work, no new run" },
      { when: "review ready", command: 'herdr-axi run accept PANE_ID --evidence "review and checks"', rule: "Review supplied report/checks first; no fabricated completion" },
      { when: "stop unfinished", command: 'herdr-axi run cancel TASK --evidence "authorized stop; partial state/background jobs reviewed"', rule: "Whole owned tab + monitor; worktree retained; interrupted cancellation: same command" },
      { when: "accepted worker", command: "herdr-axi run close PANE_ID", rule: "Whole owned tab before any external worktree cleanup" },
      { when: "all tasks resolved", command: "herdr-axi run finish", rule: "Archive results; managed retention cleanup" },
    ],
  };
}
