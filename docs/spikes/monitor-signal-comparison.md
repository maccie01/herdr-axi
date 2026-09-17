# Spike: eigene Provider-Hooks gegen Herdr-Signale

Frage: Kann herdr-axi die eigenen Monitor-Plugins (Claude, Copilot) und den
Codex-`notify`-Hook streichen und sich allein auf Herdr-Integration, Event-Wait
und Generationsnachweis stützen, ohne Signale oder Aussagekraft zu verlieren?

## Schalter

| Variable | Wirkung |
|---|---|
| `HERDR_AXI_NATIVE_HOOKS=0` | startet Worker ohne `--plugin-dir` und ohne Codex-`notify` |
| `HERDR_AXI_SIGNAL_TRACE=/pfad/trace.tsv` | protokolliert je Signal: Zeit, Quelle (`native-hook`, `event-wait`, `render`), Agent, Ereignis, Ergebnis, Grund |

Beide sind standardmäßig aus; ohne sie verhält sich die Engine wie auf `main`.

## Matrix

Je Provider (claude, copilot, codex) und Variante (Hooks 1, Hooks 0):

1. **Abschluss**: kleine Schreibaufgabe mit Abschlussbericht.
2. **Rückfrage**: Aufgabe, die vor dem Weiterarbeiten eine Rückfrage an den Nutzer stellen muss (Claude AskUserQuestion, Copilot ask_user). Codex hat keinen Input-Hook, dort nur Event-Wait.
3. **Fehler oder Kontingent**: nicht deterministisch auslösbar; nur mitschreiben, wenn es auftritt.

Zwölf Worker für 1 und 2. Aufträge klein halten.

## Ablauf

```sh
export HERDR_AXI_SIGNAL_TRACE="$PWD/trace-hooks1.tsv" HERDR_AXI_NATIVE_HOOKS=1
herdr-axi run init   # danach Export und queue --start wie von init ausgegeben
# ... Szenarien je Provider, auf Inbox warten, Worker schließen ...
export HERDR_AXI_SIGNAL_TRACE="$PWD/trace-hooks0.tsv" HERDR_AXI_NATIVE_HOOKS=0
# ... dieselben Szenarien ...
```

## Auswertung

```sh
# erstes zugestelltes Signal je Agent und Ereignis, mit Quelle
awk -F'\t' '$5=="delivered" && !seen[$3 FS $4]++ {print $3, $4, $2, $1}' trace-hooks1.tsv
# Zeitvorsprung der nativen Hooks: received native-hook gegen received event-wait
awk -F'\t' '$5=="received" && !seen[$3 FS $4 FS $2]++ {t[$3 FS $4 FS $2]=$1}
  END {for (k in t) if (k ~ /native-hook$/) {e=k; sub(/native-hook$/,"event-wait",e); if (e in t) printf "%s %.1fs\n", k, t[e]-t[k]}}' trace-hooks1.tsv
```

Vergleich Hooks 1 gegen 0: Kommt jedes Ereignis an? Wie groß ist der Zeitabstand?
Stehen im Inbox-Eintrag (`<receipt>.inbox`, Feld `detail`) dieselben Informationen,
etwa Abbruchgrund oder Dialogtext?

## Entscheidungsregel

Streichen, wenn mit Hooks 0 alle Ereignisse aus 1 und 2 ankommen, der Abschluss
höchstens einen Event-Wait-Zyklus später gemeldet wird und Rückfragen im Inbox-Eintrag
erkennbar bleiben. Sonst behalten und den fehlenden Signaltyp dokumentieren.

## Ergebnis 17.09.2026 (Herdr 0.9.0, macOS)

Rohdaten: `trace-hooks1.tsv`, `trace-hooks0.tsv` (Abschnitte durch `---` getrennt).
Workers nur lesend, `--effort low`, Repo `herdr-axi`.

| Provider | Fall | Hooks 1: zugestellt über | Eigener Hook | Hooks 0: zugestellt über |
|---|---|---|---|---|
| Claude | Abschluss | event-wait | 0,34 s früher, verworfen (`no-completion-proof`) | event-wait |
| Codex | Abschluss | event-wait | 0,34 s früher, verworfen (`no-completion-proof`) | event-wait |
| Claude | Rückfrage | event-wait | 5,75 s später, verworfen (`duplicate-event`) | event-wait, 3,5 s nach erstem Leerlauf (Hooks 1: 2,9 s) |
| Copilot | beide | nicht messbar | | nicht messbar |
| alle | Fehler/Kontingent | nicht ausgelöst | | |

- In keinem Fall hat ein eigener Provider-Hook ein Signal zugestellt. Beim
  Abschluss feuert er vor dem sichtbaren Nachweis und wird verworfen; die Zustellung
  kommt Sekundenbruchteile später über Event-Wait. Rückfragen erkennt Event-Wait früher.
- Der Inbox-Eintrag ist in beiden Varianten gleich, weil stets Event-Wait zustellt.
  Der Dialogtext aus dem nativen Hook wurde nie verwendet.
- Codex-Abschluss wurde im ersten Versuch nicht zugestellt, weil der Prompt jede
  Werkzeugnutzung verbot und damit den Abschlussnachweis verhinderte (Messfehler,
  erster Abschnitt in `trace-hooks1.tsv`); Wiederholung mit korrigiertem Prompt.
- Copilot 1.0.85: Das Konto erlaubt nur `--model auto` ohne `--effort`. Herdrs
  Copilot-Integration hängt an `SessionStart`, das Copilot erst mit dem ersten Prompt
  auslöst. herdr-axi verlangt die Session vor der Übergabe (`SESSION_START_UNVERIFIED`),
  Copilot-Worker sind damit derzeit blockiert.

Damals offen, unten beantwortet: Fehler- und Kontingentfälle
(`StopFailure`, `errorOccurred`).

Einschätzung nach der Entscheidungsregel: Für Abschluss und Rückfrage liefern die
eigenen Hooks keinen Mehrwert.

## Gegenprobe 17.09.2026 (Herdr 0.9.1, macOS)

Client und Server 0.9.1, Protokoll 22, kompatibel, kein Neustart nötig.

Testabdeckung: `npm test` 296/296, `npm run test:engine` 86/86 (Worktree auf
`spike/monitor-signal-comparison`, `fix/herdr-091-compat` ist darin enthalten).
Live-Inventar und `run init` melden dieselben sieben startbaren Kinds
(pi, claude, codex, copilot, opencode, hermes, cursor) und keine Diagnose.

Versionen der Integrationsskripte gegen 0.9.0:

| Kind | 0.9.0 | 0.9.1 |
|---|---|---|
| claude | v9 | v10 |
| opencode | v11 | v12 |
| pi | v8 | v9 |
| codex, copilot, cursor, hermes | v8, v3, v1, v5 | unverändert |

Nur ein Provider mit geändertem Skript kann die Event-Wait-Zeiten verschoben haben,
darum wurde von den Messfällen nur Claude wiederholt; für Codex gilt die Tabelle
von 0.9.0 weiter. Die Unterdrückungen `no-completion-proof` und `duplicate-event`
sind Eigenschaften des Nachweisvertrags von herdr-axi, nicht von Herdr, und hängen
nicht an der Herdr-Version.

Copilot bleibt auch auf 0.9.1 nicht messbar, aus demselben Grund wie auf 0.9.0:
`agent_session` ist bei `agent get` nach 0, 5, 10, 15 und 30 Sekunden leer und wird
erst durch den ersten Prompt gesetzt (belegt: Wert erscheint unmittelbar nach
`agent prompt`, Quelle `herdr:copilot`). herdr-axi verlangt die Session vor der
Übergabe und bricht mit `SESSION_START_UNVERIFIED` ab. Das Verhalten ist damit auf
zwei Herdr-Versionen bestätigt und strukturell, kein Fehler von 0.9.0.

### Messung Claude auf 0.9.1

Rohdaten: `trace-091-hooks1.tsv`, `trace-091-hooks0.tsv`. Die Quellenzuordnung war
zunächst falsch: `herdr-orchestrator.sh collect` rief das Hook-Skript ohne
`HERDR_MONITOR_SIGNAL_SOURCE` auf und erschien deshalb als `native-hook`, auch mit
`HERDR_AXI_NATIVE_HOOKS=0`. Die Quelle heißt jetzt `collect`; die Messung wurde
danach wiederholt.

| Fall | Variante | Erstes Signal | Zustellung | Eigener Hook |
|---|---|---|---|---|
| Abschluss | Hooks 1 | event-wait, verworfen (`no-completion-proof`) | event-wait nach 21,8 s | 0,6 s vor der Zustellung, verworfen (`no-completion-proof`) |
| Abschluss | Hooks 0 | event-wait, verworfen (`no-completion-proof`) | event-wait nach 17,9 s | keine Zeile |
| Rückfrage | Hooks 1 | event-wait `input` | event-wait sofort | 5,8 s später, verworfen (`duplicate-event`) |
| Rückfrage | Hooks 0 | event-wait `input` | event-wait sofort | keine Zeile |

Die Zustellung hängt in beiden Varianten am zweiten Ruhezustand des Workers, also am
Schreiben des Abschlussnachweises, nicht am Hook. `collect` des Orchestrators läuft
danach und wird als `duplicate-settled` verworfen.

### Fehler- und Kontingentfälle: Antwort aus dem Code

Ein echter Fehlschlag mitten im Zug war nicht kontrolliert auslösbar (ein
abgelehnter Dialog endet in `settled`, `ctrl+c` beendet Claude nicht). Die Frage
lässt sich aber am Code entscheiden, versionsunabhängig:

- `herdr-hook-notify.sh:472` wendet den Nachweisvertrag nur auf `settled` an.
  `error` und `quota` werden davon nicht verworfen und tragen den Grund des
  Anbieters (`hook_message`, `quota_json`).
- `herdr-lifecycle-monitor.sh` kann `quota` nur heuristisch melden (Zustand
  `unknown`) und `lost` beim Verschwinden des Workers. Ein `error`-Ereignis
  erzeugt der Event-Wait-Pfad nie.

Damit sind die eigenen Provider-Hooks die einzige Quelle für einen Fehlerabbruch
mit Begründung und für Kontingentdaten des Anbieters.

## Entscheidung

Nach der Entscheidungsregel: nicht komplett streichen. Für Abschluss und Rückfrage
liefern die eigenen Hooks auf 0.9.0 und 0.9.1 nachweislich keine Zustellung, wohl aber
für `error` und `quota`. Empfehlung: die Hook-Ereignisse auf `error` und `quota`
zusammenziehen und die `settled`- und `input`-Pfade der eigenen Plugins entfernen;
das streicht Code ohne Signalverlust. Der Schalter `HERDR_AXI_NATIVE_HOOKS` und die
Trace-Instrumentierung bleiben, bis diese Verengung umgesetzt ist.
