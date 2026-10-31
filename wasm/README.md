# Grammatiche Tree-sitter

Le grammatiche precompilate sono distribuite dalla dipendenza `tree-sitter-wasms`, fissata nel lockfile. L'indicizzatore risolve localmente i sei file `out/tree-sitter-{typescript,tsx,javascript,python,rust,go}.wasm` tramite `createRequire`, senza download a runtime né compilazione C++.

Questa cartella documenta gli asset: non duplica i binari presenti in `node_modules`. `npm ci` installa tutto il necessario anche per eseguire la build da una directory di lavoro diversa.

Il runtime `web-tree-sitter` 0.25.x è stato verificato con queste grammatiche. Prima di aggiornarlo, eseguire i test di tutti i linguaggi: la compatibilità ABI delle grammatiche WASM non è garantita tra versioni principali del runtime.

Licenze e provenienza delle grammatiche restano nel pacchetto distribuito: [tree-sitter-wasms](https://github.com/Gregoor/tree-sitter-wasms). Il parser segue l'API di [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web).
