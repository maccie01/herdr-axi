# Herdr 0.9.0 — Änderungsprotokoll und herdr-axi Impact-Analyse

Stand: 2026-09-08
Maschine: `herdr 0.9.0` in `~/.local/bin/herdr` (ersetzt Homebrew 0.8.0)
herdr-axi: Refactor-Zweig auf Basis der veröffentlichten `0.3.0`

---

## 1. Kurzfassung

Herdr 0.9.0 ist ein Architektur-Release: Client-seitiges TUI, Multi-Client-Views, SSH-Maschinenverwaltung (`herdr machine`), schärfere Lifecycle-API und Breaking Changes bei Worktree-Group-Close und `--no-session`. Für herdr-axi bedeutet das:

- **Sofort:** Versions-Pin dokumentieren, `agent prompt --wait` und `agent read` Verhalten verifizieren, Lifecycle-Subscription-Semantik in Monitor/Hooks prüfen.
- **Kurzfristig:** Duplikat-Stack mit `ordex/dotfiles/herdr` konsolidieren; `herdr --skill` als Referenz für Guide/Help nutzen.
- **Mittelfristig:** Neue Herdr-Fähigkeiten (Maschinen, verbesserte Agent-Detection, Client/Server-Split) in Fleet-Orchestrierung einbauen; Eigenbau nur behalten, wo Herdr keine Task-/Proof-Semantik hat.
- **Langfristig:** Receipt/Monitor-Schicht gegen Herdrs raw Socket-Lifecycle-API evaluieren. Das ist kein CLI-Tausch: ein korrekter Client muss Subscription-Ack, Snapshot-Pufferung, Sequenz und Reconnect selbst verwalten. Receipt-Dateien und deren Wakeup bleiben als Proof-/Audit-Grenze.

---

## 1a. Korrekturen vom 08.09.2026 (Code- und CLI-Verifikation)

Drei Punkte der ursprünglichen Analyse waren falsch oder falsch eingestuft. Sie sind hier korrigiert; die folgenden Abschnitte wurden angepasst.

**K1: `herdr notification` ist kein Event-API; eine Socket-API existiert aber.**
`notification show <title> [--body] [--position] [--sound]` zeigt nur einen vom
Aufrufer ausgelösten Desktop-Toast. Unabhängig davon bietet der newline-delimited
JSON-Socket `events.subscribe` und `events.wait`. Die CLI kapselt diese Methoden
nicht (`herdr api` bietet nur `snapshot` und `schema`). Folgerungen:

- Datei-basiertes Wakeup (`src/run-wake.mjs`, fs.watch auf Receipts) bleibt die
  Orchestrator-Mechanik; Herdr-Lifecycle kennt keine herdr-axi Receipt-/Proof-Semantik.
- Ein späterer Socket-Monitor muss zuerst subscriben und den Ack abwarten, Events
  puffern, dann `session.snapshot` lesen und nach Reconnect erneut snapshotten.
- `notification show` bleibt als Operator-UX nutzbar (Toast bei Phasenwechsel,
  blocked, run finish), ist aber kein Architektur-Element.
- Der dokumentierte Gap "Hooks wecken Orchestrator nicht" bleibt bestehen.

**K2: Herdr besitzt eine echte Multi-Machine-Ansicht, aber keine globale CLI-
Adressierung.** `herdr machine` verwaltet SSH-Profile; das TUI verbindet mehrere
Server, zeigt deren Workspaces und Agenten gemeinsam und reconnectet sie unabhängig.
IDs und Agent-Namen bleiben jedoch pro Server gescoped. Die Auswahl im TUI retargetet
keinen CLI-Aufruf in einem bestehenden Pane. Multi-Host-Automation bedeutet daher:
herdr-axi auf dem Zielhost/in der Ziel-Session ausführen und Ergebnisse aggregieren.

**K3: Lifecycle No-Replay ist Niedrig/Mittel, nicht Hoch.** Der Monitor
(`engine/herdr-lifecycle-monitor.sh`) nutzt keine Socket-Subscription, sondern
dual `agent wait --until` plus Tick-Loop. Missed Transitions heilen selbst: nach
`HERDR_MONITOR_CHANGE_WAIT_TICKS=600` (60 s) werden die Waiter abgebrochen, der
Loop liest `agent get` neu. Verbleibende Lücke ist der Millisekunden-Spread
zwischen `agent get` und `agent wait`-Registrierung, und nur bei
flip-and-return. Kein P0-Umbau; P3-Refactor kann die Erkennungslatenz senken.

**Entscheidungen (Stand 08.09.2026):**

| Frage | Entscheidung |
|-------|--------------|
| D1 Multi-Host | Option B: Herdr-TUI als Sichtschicht; Run lebt auf dem jeweiligen Host, herdr-axi wird dort ausgeführt, ein Aggregator sammelt Status. Kein Run über Maschinen-Grenzen (bricht Receipt-, Lease- und Lock-Modell). |
| D2 dotfiles/herdr | Option B: Deprecated-Header plus Hinweis auf herdr-axi engine, eine Quelle der Wahrheit. |
| D3 Mindest-Herdr | Option B: Runtime-Probe über `herdr status --json`; Client **und serverseitiger Behavior-Owner** müssen >=0.9 sein, private Protokoll-Inkompatibilität ist fatal, Endpoint-Generation ist nur eine UI/SSH-Warnung. `engines.herdr` allein reicht nicht. |
| D4 Enter-Fallback bei stalled | Entfernt: Upstream garantiert geordnete Text+Enter-Submission und warnt, dass stalled/timeout keine Nicht-Zustellung beweist. `agent_prompt_stalled` bleibt fail-closed in der Registry-Stage. |

---

## 2. Versions-Baseline

| Komponente | Alt | Neu | Installationspfad |
|------------|-----|-----|-------------------|
| Herdr Binary | 0.8.0 (Homebrew, Aug 2025) | **0.9.0** (Release 2026-09-07) | `~/.local/bin/herdr` |
| Übersprungen | 0.8.2 (nie lokal installiert) | — | — |
| Protokoll | — | **endpoint_protocol_generation: 1** | `herdr status --json` |
| Claude-Integration | v8 | **v9** | `ordex/dotfiles/claude/hooks/herdr-agent-state.sh` |
| herdr-axi | 0.2.1 vor Analyse | **0.3.0 + Refactor-WIP** | `~/dev/tools/herdr-axi` |

Upstream-Vergleich: `v0.8.0…v0.9.0` umfasst 841 Dateien
(+123.431/-77.576), der strikte `v0.8.2…v0.9.0`-Diff 623 Dateien
(+98.243/-78.374). Die Größe stammt wesentlich aus dem Client/Server-Umbau;
sie ist kein Maß für die herdr-axi-Änderungsfläche. Vollständige Release Notes:
`~/.config/herdr/release-notes.json`, Tag `v0.9.0`.

---

## 3. Herdr-Änderungen seit der vorherigen Version

### 3.1 CLI — Neu

| Feature | Befehl / Verhalten | Relevanz für herdr-axi |
|---------|-------------------|------------------------|
| SSH-Maschinen | `herdr machine list\|add\|rename\|remove\|enable\|disable` | Fleet über mehrere Hosts; heute nicht abgedeckt |
| Agent-Ressourcen | `herdr --skill`, `herdr.dev/agent-guide.md`, `herdr.dev/llms.txt` | Guide/Help in herdr-axi angleichen |
| Worktree-Trust | `worktree create\|remove --trust-repository` | Recovery/Worker-Start in fremden Worktrees robuster |
| Group-Close | `workspace close --group` | Schließt Parent + Worktree-Kinder explizit |

### 3.2 CLI — Geändert

| Änderung | Detail | herdr-axi betroffen? |
|----------|--------|---------------------|
| `agent prompt` | Sendet Text + Enter zuverlässig; `--wait` verlangt beobachtetes working/blocked | **Ja** — `herdr-receipt.sh`, Worker-Delivery |
| `agent read` | Recent-Reads enthalten Viewport noch ohne Scroll | **Ja** — Checkpoints, Quota-Scrape, `read` |
| `pane report-agent` | Optionen vor Pane-ID; `--option=value` | Gering — nicht direkt genutzt |
| `agent explain --file` | Strukturierte JSON-Fehler | Gering |
| `herdr update` | Client-Upgrade ohne Server-Stop möglich | Ops: Worker-Env `HERDR_BIN` beachten |
| Help-Routing | AI-Hinweise auf externe Docs statt inline | Dokumentation |

### 3.3 CLI — Entfernt (Breaking)

| Entfernt | Ersatz | herdr-axi |
|----------|--------|-----------|
| `--no-session` (Monolith-Modus) | Immer Server/Client; detach mit `Ctrl+b q`, Stop mit `herdr server stop` | Kein direkter Bezug; `HERDR_ENV=1` bleibt Pflicht |

### 3.4 Konfiguration

| Setting | 0.8.0 | 0.9.0 | Migration |
|---------|-------|-------|-----------|
| `terminal.kitty_graphics` | unter `[experimental]`, default `false` | top-level `[terminal]`, default **`true`** | Alias `experimental.kitty_graphics` noch gültig |
| `ui.pane_borders` | boolean | `"auto"` / `"always"` / `"off"` | Booleans noch akzeptiert |
| `theme.custom` | ein Block | separate `.light` / `.dark` Overrides | Nur UI |
| Sidebar | ohne `machine` Token | Default-Rows inkl. **`machine`** | Fleet-UI später |
| Client/Server-Split | implizit | **explizit dokumentiert** | Remote: Client-Theme, Server-Pane-Defaults |

### 3.5 Architektur / Server

1. **Client-seitiges TUI** — Rendering, Themes, Copy-Mode laufen pro Client, nicht auf dem Server.
2. **Unabhängige Multi-Client-Views** — Verschiedene Clients können verschiedene Workspaces/Tabs sehen.
3. **Kompatible Client-Updates** — Client kann aktualisiert werden; fehlende Server-Features deaktivieren nur betroffene Aktionen.
4. **Endpoint-Protokoll Generation 1** — Ältere Server brauchen einmaliges Upgrade (lokal: kompatibel).

### 3.6 Socket-API / Lifecycle

| Änderung | Auswirkung |
|----------|------------|
| `WorkspaceCloseParams.close_group: boolean` | Group-Close explizit |
| `ServerCapabilities.endpoint_protocol_generation` | Versionsverhandlung möglich |
| **Lifecycle-Subscriptions: nur Live-Events, kein Replay** | Clients müssen **vor** Snapshot subscriben |
| `pane read` recent window | Viewport-Output inkludiert |

Die Lifecycle-API ist nicht neu: `events.subscribe` und `events.wait` gab es
bereits vor 0.9. Neu ist, dass allgemeine Lifecycle-Subscriptions nicht mehr bei
Sequenz 0 beginnen und damit keine retained History wiedergeben. Der Server hält
die während des Subscription-Setups eintreffenden Events fest. Für einen lokalen
Cache reicht das allein nicht: Subscription-Verbindung öffnen, Ack abwarten,
Stream puffern, `session.snapshot` auf einer zweiten Verbindung holen, gepufferte
Events geordnet anwenden. Nach jedem Reconnect ist ein neuer Snapshot nötig.

`events.wait` unterstützt einzelne, serverseitig verwaltete Waits; `agent.wait`
nutzt diese eventgetriebene Infrastruktur und bindet die beobachtete Pane-Belegung.
Es gibt aber keinen CLI-Befehl für einen langlebigen gemultiplexten Event-Stream.

### 3.7 Agent-Detection (verbessert)

Betrifft indirekt herdr-axi, weil `agent wait`, blocked-Recovery und Monitor auf korrekte Zustände bauen:

- **Claude Code:** Turn/Background-Agent, MCP/Bash-Approval blocked, Cursor-Hook-Isolation (Integration v9).
- **Codex:** blocked-Genauigkeit, Session-Save vor erstem Prompt, Windows-Prompt-Timing.
- **Copilot CLI:** bleibt `working` bei Background-Agents.
- **Oh My Pi:** kein idle-Flicker bei Continuations.
- **OpenCode:** Parent nicht mehr stuck blocked nach Child-Prompts.
- **Neu: Muse** — Detection-Manifest.

Manifeste werden bei laufendem Server nachgeladen (kein Restart nötig).

### 3.8 Remote / SSH (neu in 0.9.0)

- Lokale + gespeicherte SSH-Maschinen in einem Fenster.
- Kombinierte Agent-Liste, machine-scoped Navigation, Auto-Reconnect.
- Getrennte Maschine unterbricht andere nicht.
- SSH-Client-Detach statt Pane-Resize bei Terminal-Verlust.

### 3.9 Workspaces / Worktrees

| Änderung | Breaking? |
|----------|-----------|
| Parent-Close mit offenen Worktree-Kindern erfordert `--group` | **Ja** |
| `--trust-repository` für einmaliges Git-Trust | Nein |
| Background-Worktree-Remove ändert Focus nicht mehr | Verhalten |
| Windows: Worktree-Remove mit laufenden Agent-Panes | Verhalten |

### 3.10 UI / Input / Plattform (Auswahl)

- Maus-Selektion bleibt während Output sichtbar; Copy vor Mouse-Release.
- Kitty Graphics default on; an Client gebunden.
- Prefix-Bindings mit macOS Option / Custom Layouts.
- Windows: OpenSSH, Clipboard, Antigravity, Devin, `install.cmd` Bootstrap.
- WSL: Bild-Paste aus Windows-Clipboard.

### 3.11 Übersprungene 0.8.2-Features (0.8.0 → 0.9.0 Sprung)

Falls relevant für ältere Docs: Qwen-Detection, Tab-Bar-Status,
`move_tab_previous/next`, Windows `herdr --remote`, Cursor Agent CLI,
MastraCode, Hermes, Grok, Copy-Mode `B`/`E`/`W`, Plugin-Marketplace-Subdirs,
Headless 120×40 (statt 80×24), Windows GA. Auch
`agent_prompt_stalled` und `recent-unwrapped` waren in 0.8.2 bereits
dokumentiert. 0.9 verschärft/fixed deren Umsetzung: nur beobachtetes
`working|blocked` öffnet das Activity-Gate, Text+Enter werden geordnet zugestellt,
und Recent-Reads enthalten nun auch noch sichtbaren Viewport-Output.

---

## 4. Lokaler Bash-Stack (nicht upstream)

Parallel zu herdr-axi existiert `ordex/dotfiles/herdr/` — ein älterer, schmalerer Orchestrator-Layer (Sep 2–4, 2026):

```
ordex/dotfiles/herdr/herdr-orchestrator.sh
ordex/dotfiles/herdr/herdr-worker.sh
ordex/dotfiles/herdr/herdr-hook-notify.sh
ordex/dotfiles/herdr/herdr-lifecycle-monitor.sh
ordex/dotfiles/herdr/herdr-monitor-plugins/
```

**Diff zu `herdr-axi/engine/`:** alle Kern-Skripte divergieren; herdr-axi hat zusätzlich `herdr-receipt.sh`, Managed-Run-Modell, Tests (`test-herdr-monitor.sh`).

Dotfiles-Commits seit Import:

| Commit | Inhalt |
|--------|--------|
| `ca46a12` | Initial-Import Orchestrator/Worker/Monitor |
| `d07285f` | Codex ≥0.149: `--approve-for-me` vs `--sandbox` |
| `33ad77e` | Monitor-Input-Events mit neuem Fingerprint |
| `5b004d6` | Fingerprint ohne Hook-Title (Dedup native + Monitor) |

**Fazit:** Zwei Forks desselben Konzepts. herdr-axi ist der vollständige Managed-Run-Pfad; dotfiles-herdr ist Legacy/lightweight.

---

## 5. herdr-axi heute — Architektur und Herdr-Kopplung

### 5.1 Schichten

```
bin/herdr-axi.mjs → src/*.mjs (CLI, Policy, Run-State)
        ↓ spawn
engine/*.sh → herdr CLI → Tabs/Panes/Agents
        ↓
Native CLIs (claude/codex/copilot) in Worker-Panes
```

State: `~/.local/state/herdr-axi/` (Runs, Leases, Archive). Policy: `.herdr-axi.json`.

### 5.2 Herdr-CLI-Aufrufe (vollständig)

**JavaScript (`src/herdr.mjs`):**

- `agent list`, `agent get`, `agent read` (`visible` / `recent` / `recent-unwrapped`)
- `agent wait --until STATE --timeout MS`
- `agent prompt`, `agent send-keys`
- `pane current --current`, `pane get`
- `tab rename`, `tab get`

**Engine (Bash):**

- `tab create` (mit `--env`, `--no-focus`), `tab close`
- `pane split`, `pane run` (der frühere Monitor-Startup via `pane wait-output --match` ist im Refactor durch einen generationsgebundenen Datei-Ack ersetzt)
- `agent start --kind`, `agent prompt --wait`, `agent wait`, `agent read`, `agent get`, `agent send-keys enter`

### 5.3 Eigenbau (nicht an Herdr delegiert)

| Bereich | Implementierung | Überschneidung mit Herdr 0.9 |
|---------|-----------------|------------------------------|
| Run/Task-Queue | `run.json`, Phasen, Caps, 128 Tasks, Deps | Herdr hat keine Task-API |
| Worktree-Leases | `~/.local/state/herdr-axi/writers/` | Herdr hat keine Lease-API |
| Receipt/Proof | `herdr-receipt/3`, Generationen, `.inbox`, Locks | Herdr: idle≠accepted completion |
| Lifecycle-Monitor | 25%-Pane, dual `agent wait`, Hooks | Nutzt serverseitige Waits; kein Completion-Proof in Herdr |
| Hook-Notify | Transcript-Parsing, Quota-Regex | Cursor-Isolation jetzt in Herdr |
| Watch/Wakeup | `fs.watch` auf Receipt-Dateien | Bleibt Proof-/Run-Wakeup; Herdr-Socketevents sind eine getrennte Lifecycle-Quelle (K1) |
| Quota | Terminal-Text-Regex | Kein Provider-API |
| Context | Transcript-Dateien + `agent read` | Unverändert |
| TOON/Guide | `axi-sdk-js`, lokale Recipes | `herdr --skill` parallel |

### 5.4 Bekannte brittliche Annahmen

1. Keine Herdr-Versionsverhandlung (Runtime-Probe fehlt komplett). 0.9 liefert Client-, Server-, private Protokoll- und Endpoint-Daten zusammen über `herdr status --json`.
2. `agent read --source recent-unwrapped` — bereits in 0.8.2 dokumentiert; 0.9 behebt den fehlenden Viewport-Anteil. Bei idle/bottom kann ein Read die App scrollen; explizite History kann bei working/blocked/unknown mit `agent_not_idle` scheitern, daher bleibt der Visible-Fallback wichtig.
3. Monitor-Startup-Ack — jetzt generationsgebundener `${receipt}.monitor-ready`-Marker; der Worker entfernt ihn nach Validierung. Damit hängt der kritische Pfad nicht von Render-Wrapping/Kitty Graphics ab.
4. `tab create --env` — viele injizierte Env-Vars.
5. Orchestrator-Identität = **Pane-ID**, nicht Agent-Name.
6. Error-Code-Mapping per Message-Substring.
7. `HERDR_ENV=1` Hard-Gate — kein Standalone-Fleet-Tool.
8. Hooks schreiben Inbox, **wecken Orchestrator nicht** (by design).
9. BSD `stat -f` in Receipt-Locks (macOS).
10. Kein serveradressierender Fleet-Adapter: Herdr-TUI aggregiert Maschinen, CLI-Aufrufe bleiben an die geerbte lokale Session gebunden.

---

## 6. Impact-Matrix: Herdr 0.9 → herdr-axi

| Herdr-Änderung | Risiko | Empfohlene Reaktion |
|----------------|--------|---------------------|
| `agent prompt --wait` strenger | Mittel | Delivery auf `--until working --until blocked` begrenzen; stalled ohne Blind-Retry/Enter behandeln |
| `agent read` recent inkl. Viewport | Niedrig | Positiv für Checkpoints/Quota; Regression-Test; `recent-unwrapped` ist jetzt dokumentierter Empfehlungspfad |
| Lifecycle kein Replay | **Niedrig/Mittel** (korrigiert K3) | Bestehender Monitor nutzt `agent wait`, nicht `events.subscribe`; P3-Socket-Umbau nur mit Ack→Buffer→Snapshot→Replay und Reconnect |
| Worktree group close | Mittel | `run close`/Archive: `--group` wenn Parent+Kinder |
| `--no-session` entfernt | Niedrig | Docs: immer Server-Modell |
| Client/Server-Split | Mittel | `HERDR_BIN` in Worker pinnen; Update-Pfad dokumentieren |
| Verbesserte blocked/detection | Niedrig | Weniger false positives in Monitor; ggf. Retry-Pfade vereinfachen |
| Claude Cursor-Hook-Isolation | Niedrig | Hook-Plugins redundant teilweise; Dedup-Logik reviewen |
| `herdr machine` | Chance: Profile + echte TUI-Aggregation (korrigiert K2) | Herdr-Sichtschicht nutzen; herdr-axi-Kontrolle weiter auf dem Zielhost, weil CLI nicht serveradressierbar ist |
| Multi-Client Views | Chance | Owner/Takeover über Client-Grenzen härten |
| `herdr --skill` | Chance | `guide` mit Herdr-Skill synchron halten |
| Integration v9 | Niedrig | Monitor-Plugins gegen neue Hook-Semantik testen |

---

## 7. Anpassungs- und Verbesserungsplan

### Phase A — Kompatibilität (aktueller Refactor nach v0.3.0)

1. **`engines.herdr` in package.json** — `"herdr": ">=0.9.0"` + README/Operator-Guide. Wichtig: npm prüft `engines` nicht gegen ein Binary; das eigentliche Gate ist die Runtime-Probe (Punkt 6).
2. **Smoke gegen 0.9.0** — gezielte Contract-Checks (Status-Shape, Prompt-Delivery, Monitor-Startup, blocked recovery); ressourcenintensive Voll-Suites getrennt und explizit ausführen.
3. **Lifecycle-Race** — kein Umbau nötig (K3): Monitor heilt verpasste Transitions über den 60 s Re-Snapshot. Nur Dokumentation der Latenz-Eigenschaft.
4. **Group-Close** — `run close`/Worker-Cleanup schließt Tabs einzeln, nie den Parent-Workspace; Normalpfad unberührt. Docs-Warnung gegen manuelles Schließen des Run-Workspaces genügt, kein Code.
5. **Dotfiles-Konsolidierung** — `ordex/dotfiles/herdr` als deprecated markieren oder als Symlink/Thin-Wrapper auf herdr-axi engine; eine Quelle der Wahrheit (Entscheidung D2: deprecated markieren).
6. **Runtime-Versionsprobe** — bei `run init` einmal `herdr status --json` lesen. Client und Server müssen >=0.9 sein; `server.compatible=false` ist fatal. Beide Versionen/Protokolle und Endpoint-Generationen in `run.json` schreiben. Endpoint-Mismatch nur warnen: herdr-axi nutzt CLI/Socket, nicht den TUI/SSH-Endpoint.
7. **Prompt-Flags an 0.9 anpassen** — Delivery ist nicht Completion: `--until working --until blocked` lässt das von Herdr beobachtete Activity-Gate den Startup-Ack erfüllen, statt bis `idle|done` zu warten. Stalled-Enter-Fallback entfernen und `agent_prompt_stalled` fail-closed behandeln (Entscheidung D4).

### Phase B — Nutzen von Herdr 0.9 (Follow-up nach dem Refactor)

| Feature | Aktion | Ersetzt Eigenbau? |
|---------|--------|-------------------|
| `herdr machine` | Profile und vorhandene TUI-Aggregation nutzen; Ausführung je Host/Session, zusätzlicher `fleet status` nur für herdr-axi Run-Daten (D1) | Nein, erweitert Fleet |
| `herdr notification show` | Operator-Toast bei Phasenwechsel/blocked/run finish; **kein** Wakeup-Pfad (K1) | Nein, reine UX |
| Verbesserte `agent wait` | Monitor vereinfachen wo Detection stabil | **Teilweise** Polling-Fallback |
| `worktree --trust-repository` | In `run queue`/`recover` bei Git-Trust-Fehlern | Nein, nutzt Herdr |
| `herdr --skill` diff | `guide`/`--skill` periodisch diffen und TOON-Rezepte aktualisieren | Nein |
| Server-Capabilities | Runtime-Probe bei `run init` (Phase A Punkt 6) | Nein |

### Phase C — Eigenbau ablösen oder behalten

| Eigenbau | Behalten | Ablösen durch Herdr | Begründung |
|----------|----------|---------------------|------------|
| Run/Phase/Task-Queue | **Ja** | — | Kerndifferenzierung; Herdr hat kein Task-Modell |
| Generation-Proof / accept-revise | **Ja** | — | idle/done ≠ reviewed acceptance |
| Worktree-Leases | **Ja** (kurz) | Später evaluieren | Cross-Run Writer-Exclusion |
| 25%-Lifecycle-Monitor-Pane | **Ja** (kurz) | Ggf. Hooks + `agent wait` only | Sichtbarkeit für Operator; nach 0.9 Detection evtl. schlanker |
| Hook-Plugins (claude/copilot) | Prüfen | Nur Lifecycle-Teile, wenn Socket-Client belastbar ist | Integration v9 + Cursor-Isolation reduziert Dedup-Bedarf; Receipt-Proof bleibt |
| Quota-Regex | **Ja** (mittel) | Provider-API falls verfügbar | Kein Herdr-Quota-API |
| Transcript-Context-Parsing | **Ja** | — | Herdr liefert kein Token-Budget |
| `fs.watch` Wakeup | **Ja** | Socketevents können Lifecycle ergänzen, ersetzen aber keinen Receipt-Proof (K1); Timer-Reconciliation deckt verlorene Filesystem-Events ab |
| `ordex/dotfiles/herdr` | **Nein** | herdr-axi engine | Duplikat entfernen |
| Receipt-Dateien auf Disk | **Ja** | — | Audit, offline `history`, Generation-Boundaries |

### Phase D — Neue Funktionalität

1. **Multi-Machine Fleet** — Runs leben auf dem jeweiligen Host (D1); herdr-axi wird per SSH dort ausgeführt, lokaler Aggregator `fleet status` fasst Profile und Host-Status zusammen. Kein Run über Maschinen-Grenzen.
2. **Protokoll-Health** — Runtime-Probe bei `run init`: Client-/Server-Version, privates Protokoll samt `compatible`, beide Endpoint-Generationen samt `endpoint_compatible` in `run.json` (Phase A Punkt 6).
3. **Expliziter Group-Lifecycle** — Docs-Warnung für manuelles Schließen des Run-Workspaces (`workspace close --group` nur nach Review); Normalpfad von `run close` bleibt Tabs-einzeln.
4. **Operator-Toast** — `herdr notification show` bei Phasenwechsel, blocked und run finish (K1: reine UX, kein Wakeup).
5. **Ready-Ack über Datei** — Monitor-Startup-Handshake in `herdr-worker.sh:291` von `pane wait-output --match` auf einen Datei-Marker im Receipt-Dir umstellen; robuster gegen Rendering-Änderungen (Kitty Graphics default on).
6. **Guide-Sync** — Script/CI: `herdr --skill` vs `herdr-axi --skill` Drift-Warnung.
7. **Event-Monitor-Spike** — Raw-Socket-Prototyp nur hinter Feature-Flag: Subscription-Ack vor Snapshot, Sequenzpuffer, Reconnect/Resnapshot, Abbruch bei Pane-Occupant-Wechsel. Erst danach Entscheidung über duale Shell-Waiter.
8. **Linux-Portabilität** — Receipt-Locks: `stat` portable machen (heute BSD-biased).

---

## 8. Konkrete Code-Stellen für Phase A

| Datei | Prüfpunkt |
|-------|-----------|
| `src/herdr.mjs` | Version probe; `mapErrorCode` für neue 0.9 Codes |
| `engine/herdr-receipt.sh` | `agent prompt --wait --until working --until blocked`: Aktivitäts-Ack statt Task-Completion; stalled-Enter-Fallback entfernt, fail-closed |
| `engine/herdr-lifecycle-monitor.sh` | Kein Sofort-Umbau nötig (K3); P3: Raw-Socket-Client gegen duale `agent wait`-Prozesse benchmarken, aber Reconnect/Snapshot korrekt lösen |
| `engine/herdr-worker.sh` | Ready-Ack (Zeile 291): `pane wait-output --match` durch Datei-Marker ersetzen |
| `engine/herdr-hook-notify.sh` | Dedup mit native Herdr-Hooks (Cursor) |
| `src/runs.mjs` | Checkpoints via `recent-unwrapped`; Version/Generation in run.json bei `run init` |
| `docs/operator-guide.md` | Herdr ≥0.9, kein `--no-session`, Server-Modell, Workspace-Close-Warnung |
| `ordex/dotfiles/*/skills/crab/SKILL.md` | Stale "herdr 0.8.0" Referenz |

---

## 9. Empfohlene Prioritäten

| Prio | Item | Aufwand | Nutzen |
|------|------|---------|--------|
| P0 | Prompt-Contract + fail-closed stalled-Pfad | erledigt im Refactor | Stabilität, keine Doppelzustellung |
| P0 | Runtime-Versionsprobe (run init) + engines + Docs | 0.5 bis 1 Tag | Fail-fast, Protokoll-Health |
| P0.5 | Prompt-Flags (`--until`-Duplikate) aufräumen | 0.5 Tag | Korrekte 0.9-Semantik |
| P0.5 | Dotfiles/herdr deprecated markieren | 0.5 Tag | Wartbarkeit |
| P1 | Group-Close Docs-Warnung | 1 h | Korrektes Cleanup |
| P1 | Ready-Ack über Datei statt Output-Match | 1 Tag | Robuster kritischer Pfad |
| P2 | `herdr machine` Profile + SSH-Host-Ausführung (D1) | 2 bis 3 Tage | Neues Feature |
| P2 | Operator-Toast (`notification show`) | 0.5 Tag | UX |
| P3 | Raw-Socket-Monitor-Spike mit Reconnect/Resnapshot | 2 bis 4 Tage | Ein Stream statt Shell-Waiter, aber nur bei nachgewiesener gleicher Zuverlässigkeit |
| P3 | Guide/Skill-Sync, stat-Portabilität | laufend | Agent-Ergonomie, Portabilität |

---

## 10. Offene Fragen

Entscheidet (Stand 08.09.2026, siehe Abschnitt 1a): D1 (Multi-Host, Option B),
D2 (dotfiles deprecated), D3 (Runtime-Probe, beide Seiten unter 0.9 fail),
D4 (stalled-Fallback entfernt). Verbleibend:

1. Operator-Toast: welche Events verdienen einen Toast (Phasenwechsel, blocked, run finish)?
2. SSH-Host-Ausführung: direkter `ssh <host> herdr-axi ...` oder Agent-Relay über einen SSH-Pane pro Host?
3. Monitor-Architektur: bleibt dual `agent wait` der einfachere verlässliche Weg, oder rechtfertigt die Prozessersparnis einen kleinen Socket-Client samt Snapshot-/Reconnect-State-Machine?

---

## Anhang: Herdr-CLI-Referenz (0.9.0, relevant für herdr-axi)

```bash
herdr --version                    # Client-Version
herdr status --json                # Client + Server + private/Endpoint-Kompatibilität
herdr agent list|get|read|wait|prompt|start|send-keys
herdr pane current|get|split|run|wait-output
herdr tab create|close|rename|get
herdr workspace close --group      # NEU: explizit
herdr worktree create --trust-repository
herdr machine list|add|...         # NEU
herdr --skill                      # aktualisierte Agent-Anleitung
herdr api snapshot|schema          # kein CLI-Wrapper für events.subscribe
```

Quellen: `~/.config/herdr/release-notes.json`, `herdr --skill`,
versionsgepinntes Upstream-Tag `herdrdev/herdr@v0.9.0` (insbesondere
`socket-api.mdx`, `agent-automation.mdx`, `connecting-machines.mdx`,
`src/api/{subscriptions,wait}.rs`, `src/cli/status.rs`), Live-Inspektion
2026-09-08 und herdr-axi Quellcode unter `src/` und `engine/`.
