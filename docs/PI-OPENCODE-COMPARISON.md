# Pi e OpenCode: differenze e prossime implementazioni

Ricerca online del **31 ottobre 2026**, sulle documentazioni ufficiali correnti. Per Pi si intende il coding agent di pi.dev, non un progetto omonimo. Le funzionalità elencate sono documentate, non provate in benchmark comparativi. Le proposte sono valutazioni per questo repository: non sono state implementate nella Fase 5.

Il vantaggio da conservare in nim-codex è la combinazione di **NIM esclusivo, pacing condiviso di 1600 ms, tool batch e discovery AST locale senza chiamate al modello**. Non basta distinguersi dicendo «supporta NVIDIA»: Pi e OpenCode documentano già quel provider. Non ho trovato nelle pagine consultate una garanzia equivalente al nostro limite fisso per processo; questo non dimostra che non possano essere configurati per rispettarlo. [Pi](https://pi.dev/), [provider OpenCode](https://docs.opencode.ai/docs/providers/).

## Confronto

| Funzionalità | nim-codex oggi | Pi | OpenCode |
| --- | --- | --- | --- |
| Provider e modello | Solo NIM, catalogo locale, cambio modello nella sessione | Molti provider, incluso NVIDIA; cambio modello | Molti provider, incluso NVIDIA; configurazione provider/modelli |
| Sessioni persistenti | Solo RAM; uscita = perdita della conversazione | JSONL persistente, albero delle conversazioni, ripresa e fork | Ripresa, selezione sessione e fork da CLI/TUI |
| Istruzioni del progetto | Prompt fisso; non carica AGENTS.md a runtime | Context file e skill scoperti/caricati nel contesto | AGENTS.md di progetto e regole globali/configurate |
| Compattazione | Estratti locali limitati; nessuna richiesta extra | Riassunti strutturati e cronologia originale conservata | Agente di compattazione automatico |
| Permessi | Validazione dei tool e confine dei percorsi; shell non isolata | Trust del progetto, permessi OS; estensioni per controllare tool | Regole allow/ask/deny per tool e percorsi; approvazioni in UI |
| Pianificazione e delega | Un solo agente, nessun plan mode | Plan mode e subagent non fanno parte del nucleo descritto; estendibile | Build, Plan e subagent specializzati |
| Annullamento modifiche | Diff e cancellazione; niente undo | Navigazione/fork della conversazione; checkpoint Git tramite estensioni | Undo/redo può ripristinare file tramite Git |
| Comprensione del codice | Grafo AST locale per TS/JS, Python, Rust e Go | Contesto e tool estendibili; nelle fonti consultate non è descritto un grafo automatico equivalente | Integrazione LSP opzionale per diagnostica; non equivale al nostro grafo AST |
| MCP ed estensioni | Nessuno | Estensioni TypeScript, skill, template; MCP integrato nella documentazione attuale | Plugin, tool custom, skill e server MCP |
| Interazione e integrazioni | TUI inline e un turno plain-output; input bloccato durante il lavoro | Steering/follow-up, TUI, print/JSON, RPC e SDK | TUI, CLI, server e integrazioni IDE/web |

Fonti per sessioni/compattazione: [Pi sessions](https://pi.dev/docs/latest/sessions), [Pi compaction](https://pi.dev/docs/latest/compaction), [OpenCode CLI](https://docs.opencode.ai/docs/cli/), [OpenCode agents](https://docs.opencode.ai/docs/agents/).

Fonti per istruzioni e interazione: [How Pi Works](https://pi.dev/docs/latest/how-pi-works), [OpenCode rules](https://docs.opencode.ai/docs/rules/), [OpenCode TUI](https://docs.opencode.ai/docs/tui/). Il fork di una conversazione non è automaticamente un rollback dei file: sono funzioni da distinguere.

Fonti per permessi/estensioni: [Pi security](https://pi.dev/docs/latest/security), [Pi extensions](https://pi.dev/docs/latest/extensions), [Pi MCP](https://pi.dev/docs/latest/mcp), [OpenCode permissions](https://docs.opencode.ai/docs/permissions/), [OpenCode MCP](https://docs.opencode.ai/docs/mcp-servers/). Le pagine Pi attuali documentano MCP nativo: non ho riutilizzato il vecchio luogo comune «Pi non ha MCP».

Fonte per LSP: [OpenCode LSP](https://docs.opencode.ai/docs/lsp/). La pagina consultata lo indica disabilitato per default e segnala che lint/typecheck da CLI possono essere preferibili. Anche Plan in OpenCode non implica una sandbox: il comportamento di Bash dipende dalle regole di permesso configurate.

## Cosa implementare, in ordine

### Prossimo milestone consigliato: continuità e contesto del progetto

1. **Sessioni JSONL e `/resume`.** Un file per conversazione, append-only, fuori dal repository e con permessi locali restrittivi. Salvare messaggi, esiti tool, modello e compattazioni; non salvare chiavi/API headers. Ripresa robusta anche con ultima riga incompleta dopo un arresto. Primo obiettivo: chiudere il programma e riaprire la stessa conversazione senza nuove chiamate NIM di ricostruzione. Nessun database, server o branching tree nella prima versione. I contenuti della sessione possono comunque includere file sensibili letti dai tool: documentare cancellazione e conservazione.

2. **Caricamento esplicito di AGENTS.md e riferimenti `@file`.** Caricare le istruzioni di un workspace fidato con una precedenza semplice e un limite di dimensione. Mostrare quali file vengono inclusi. Il completamento attuale di `@file` inserisce testo: non allega automaticamente il contenuto. Aggiungere un allegato locale limitato e verificato, distinguendo istruzioni autorizzate dal normale codice sorgente. Zero richieste API per questa operazione.

3. **Permessi minimi e modalità analisi.** Iniziare con poche regole concrete: letture consentite, segreti espliciti protetti, modifiche/shell configurabili con allow/ask/deny. La modalità analisi deve bloccare realmente gli strumenti di modifica e i comandi shell non autorizzati nel dispatcher, non solo nel prompt. In output non interattivo, una richiesta di approvazione deve fallire chiaramente anziché bloccarsi. Non promettere una sandbox se non c'è isolamento OS.

Questi tre interventi risolvono problemi quotidiani senza intaccare i tool batch o aumentare le richieste NIM. Criteri di accettazione: ripresa dopo arresto, nessuna perdita del pairing tool/result, regole di contesto verificabili e test che provino il rifiuto degli effetti collaterali in analisi.

### Dopo, se l'uso lo richiede

4. **Undo delle sole modifiche dell'agente.** Conservare prima/dopo e hash dei file toccati. Rifiutare il ripristino se l'utente ha modificato il file nel frattempo. Un comando locale esplicito, senza `git reset --hard` o pulizia automatica del workspace. Le scritture atomiche introdotte nell'audit non sostituiscono un undo.

5. **Budget di contesto e recupero dagli errori.** Usare i dati di usage quando disponibili, conservare obiettivo/file modificati/esiti dei test nella compattazione e rilevare ripetizioni identiche di tool falliti. Tenere il riassunto LLM opzionale: consuma RPM, può fallire e deve passare attraverso lo stesso limiter. Verificare capacità e disponibilità dei modelli NIM con smoke test espliciti, non con tentativi silenziosi per ogni richiesta.

6. **Indice incrementale solo dopo una misura.** Misurare il tempo di indicizzazione su un repository medio e uno grande. Se la ricostruzione domina il turno, riusare gli AST dei file invariati e aggiornare solo i file modificati. Evitare un watcher permanente e un nuovo database finché una cache locale semplice non risulta insufficiente.

## Cosa rimandare

- Multi-provider: contrasta con la scelta NIM esclusiva; cambiare questa scelta richiede un nuovo obiettivo, non un refactor.
- Multi-agent e pipeline parallele: prima servono budget, osservabilità e code condivise; più agenti possono sprecare il limite di 40 RPM.
- Framework di plugin, marketplace, server HTTP, IDE/web UI: nessun caso d'uso attuale li richiede.
- MCP: utile quando c'è un servizio concreto da collegare; non aggiungere decine di tool al prompt senza necessità.
- LSP generalizzato: prima usare i comandi di test e typecheck già disponibili; attivarlo in seguito per un bisogno misurato.
- Compattazione LLM sempre attiva: mantenere un percorso locale affidabile in caso di limiti o disservizi del provider.

## Decisione proposta

Conservare il prodotto piccolo. Implementare prima **sessioni recuperabili + AGENTS.md + permessi/analisi**, poi undo e gestione del contesto. La parità di funzionalità con Pi o OpenCode non è un obiettivo utile quanto un agente NIM prevedibile che non perde il lavoro e usa bene le richieste disponibili.
