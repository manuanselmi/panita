// The approval card's explanations (src/core/explain.ts): the dictionary rule
// by rule, chains, what stays unknown, the dangerous ones, the git branch they
// may name, and the small parser underneath. Pure functions — no DOM, no app.
//
// Adding a rule? Add its case to the table of its group: [command, the line,
// dangerous?]. A null line means "no explanation at all".

import { describe, expect, it } from "vitest";
import {
  explainCommand,
  explainTool,
  explanationText,
  messageTitle,
  parseArgs,
  resolveFolder,
  splitCommand,
  type Branches,
} from "../../src/core/explain";

const line = (command: string, branches?: Branches) => {
  const e = explainCommand(command, branches);
  return e ? explanationText(e) : null;
};

type Case = [command: string, line: string | null, danger?: boolean];

function table(cases: Case[]) {
  it.each(cases)("%s → %s", (command, expected, danger = false) => {
    const e = explainCommand(command);
    expect(e ? explanationText(e) : null).toBe(expected);
    expect(e?.danger ?? false).toBe(danger);
  });
}

describe("git", () => {
  describe("push", () =>
    table([
      ["git push origin main:dev", 'Push de "main" a "dev"'],
      ["git push", "Push de la rama actual"],
      ["git push origin", "Push de la rama actual"],
      ["git push origin HEAD", "Push de la rama actual"],
      ["git push origin main", 'Push de "main"'],
      ["git push -u origin feature/islas", 'Push de "feature/islas"'],
      ["git push upstream main", 'Push de "main" (remoto "upstream")'],
      ["git push https://github.com/a/b.git main", 'Push de "main" (remoto "github.com")'],
      ["git push --force origin main", 'Push de "main" (forzado)', true],
      ["git push -f", "Push de la rama actual (forzado)", true],
      ["git push --force-with-lease origin dev", 'Push de "dev" (forzado)', true],
      ["git push origin +main", 'Push de "main" (forzado)', true],
      ["git push origin --delete old", 'Borrar la rama remota "old"', true],
      ["git push origin :old", 'Borrar la rama remota "old"', true],
      ["git push --tags", "Push de los tags"],
    ]));

  describe("commit", () =>
    table([
      ['git commit -m "fix"', 'Commit en la rama actual: "fix"'],
      ['git commit -am "wip"', 'Commit en la rama actual: "wip"'],
      ["git commit --message=listo", 'Commit en la rama actual: "listo"'],
      ["git commit", "Commit en la rama actual"],
      ["git commit --amend --no-edit", "Reescribir el último commit en la rama actual"],
      ['git -C ../otro commit -m "x"', 'Commit en la rama actual: "x"'],
    ]));

  it("reads the title out of the heredoc message Claude Code writes", () => {
    const command = [
      `git commit -m "$(cat <<'EOF'`,
      "Windows: the right card (is) only panitas",
      "",
      `Body with "quotes", an apostrophe's and $(parens).`,
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      "EOF",
      `)"`,
    ].join("\n");
    expect(line(command)).toBe('Commit en la rama actual: "Windows: the right card (is) only panitas"');
    // The heredoc's text is the message, not more commands.
    expect(explainCommand(command)?.parts).toHaveLength(1);
  });

  describe("pull, fetch", () =>
    table([
      ["git pull", "Pull en la rama actual"],
      ["git pull origin main", 'Pull de "main" en la rama actual'],
      ["git pull --rebase", "Pull en la rama actual (con rebase)"],
      ["git fetch", "Traer las novedades del remoto"],
      ["git fetch upstream", 'Traer las novedades del remoto (remoto "upstream")'],
    ]));

  describe("checkout, switch, restore", () =>
    table([
      ["git checkout -b feat/x", 'Crear la rama "feat/x" y pasarse a ella'],
      ["git checkout -b hotfix main", 'Crear la rama "hotfix" desde "main" y pasarse a ella'],
      ["git checkout main", 'Pasarse a la rama "main"'],
      ["git checkout -", "Volver a la rama anterior"],
      ["git checkout -- src/a.ts", 'Descartar los cambios de "a.ts"', true],
      ["git checkout src/a.ts", 'Descartar los cambios de "a.ts"', true],
      ["git checkout .", "Descartar todos los cambios sin commit", true],
      ["git checkout main -- package.json", 'Reemplazar "package.json" por la versión de "main"', true],
      ["git switch dev", 'Pasarse a la rama "dev"'],
      ["git switch -c nueva", 'Crear la rama "nueva" y pasarse a ella'],
      ["git restore src/a.ts", 'Descartar los cambios de "a.ts"', true],
      ["git restore --staged src/a.ts", 'Sacar "a.ts" del staging'],
    ]));

  describe("merge, rebase, reset", () =>
    table([
      ["git merge feature", 'Merge de "feature" en la rama actual'],
      ["git merge --squash feature", 'Merge de "feature" en la rama actual (squash)'],
      ["git merge --abort", "Cancelar el merge en curso"],
      ["git rebase main", 'Rebase de la rama actual sobre "main"'],
      ["git rebase -i HEAD~3", 'Rebase interactivo de la rama actual sobre "HEAD~3"'],
      ["git rebase --continue", "Continuar el rebase"],
      ["git reset --hard", "Descartar todos los cambios sin commit", true],
      ["git reset --hard origin/main", 'Volver a "origin/main" y descartar todos los cambios sin commit', true],
      ["git reset --soft HEAD~1", 'Deshacer los commits hasta "HEAD~1" (los cambios quedan en staging)'],
      ["git reset HEAD~1", 'Deshacer los commits hasta "HEAD~1" (los cambios quedan)'],
      ["git reset src/a.ts", 'Sacar "a.ts" del staging'],
      ["git reset", "Sacar todo del staging"],
    ]));

  describe("clone, add, and the read-only ones", () =>
    table([
      ["git clone https://github.com/Louis-CFM/coucou.git", 'Clonar "coucou"'],
      ["git clone git@github.com:a/panita.git destino", 'Clonar "panita" en "destino"'],
      ["git add .", "Agregar todos los cambios al staging"],
      ["git add -A", "Agregar todos los cambios al staging"],
      ["git add src/a.ts src/b.ts", 'Agregar "a.ts" y "b.ts" al staging'],
      ["git status", "Ver el estado del repo"],
      ["git status --short", "Ver el estado del repo"],
      ["git --no-pager diff", "Ver los cambios"],
      ["git diff --staged", "Ver los cambios en staging"],
      ["git diff src/a.ts", 'Ver los cambios de "a.ts"'],
      ["git log --oneline -5", "Ver el historial de commits"],
      ["git show", "Ver el último commit"],
    ]));

  describe("branches, stash, tags, clean", () =>
    table([
      ["git branch", "Ver las ramas"],
      ["git branch -a", "Ver las ramas"],
      ["git branch nueva", 'Crear la rama "nueva"'],
      ["git branch -d vieja", 'Borrar la rama "vieja"'],
      ["git branch -D vieja", 'Borrar la rama "vieja" (aunque no esté mergeada)', true],
      ["git stash", "Guardar los cambios en el stash"],
      ["git stash pop", "Recuperar los cambios del stash"],
      ["git stash clear", "Borrar todo el stash", true],
      ["git tag v1.2.0", 'Crear el tag "v1.2.0"'],
      ["git clean -fd", "Borrar los archivos y carpetas sin seguimiento", true],
      ["git clean -n", "Ver qué archivos sin seguimiento se borrarían"],
      ["git cherry-pick abc1234", 'Aplicar "abc1234" en la rama actual'],
      ["git rm -r --cached dist", 'Dejar de seguir "dist" (el archivo queda)'],
      ["git init", "Crear un repo git"],
      ["git branch --show-current", "Ver la rama actual"],
      ["git config user.email", "Ver la configuración de git"],
      ["git config --global user.name Manuel", 'Cambiar la configuración de git ("user.name")'],
    ]));
});

describe("the current branch", () => {
  it("names the branch once it is known, for the folder the command runs in", () => {
    const e = explainCommand('git commit -m "fix"');
    expect(e?.branchDirs).toEqual([""]);
    expect(line('git commit -m "fix"', new Map([["", "dev"]]))).toBe('Commit en "dev": "fix"');
    expect(line("git push", new Map([["", "dev"]]))).toBe('Push de "dev"');
    expect(line("git pull", new Map([["", "main"]]))).toBe('Pull en "main"');
    expect(line("git merge feature", new Map([["", "main"]]))).toBe('Merge de "feature" en "main"');
  });

  it("follows a cd before the command, and git -C", () => {
    expect(explainCommand('cd ../x && git commit -m "fix"')?.branchDirs).toEqual(["../x"]);
    expect(line('cd ../x && git commit -m "fix"', new Map([["../x", "dev"]]))).toBe('Moverse a "x" → Commit en "dev": "fix"');
    // The session's own folder is not where this commit happens.
    expect(line('cd ../x && git commit -m "fix"', new Map([["", "main"]]))).toBe('Moverse a "x" → Commit en la rama actual: "fix"');
    expect(explainCommand("cd a && cd b && git push")?.branchDirs).toEqual(["a/b"]);
    expect(explainCommand("cd C:/repos/x; git push")?.branchDirs).toEqual(["C:/repos/x"]);
    expect(explainCommand("git -C ../otro push")?.branchDirs).toEqual(["../otro"]);
    expect(explainCommand('git commit -m a && cd sub && git push')?.branchDirs).toEqual(["", "sub"]);
  });

  it("after a checkout in the same line, names the branch it switched to rather than asking", () => {
    const e = explainCommand("git checkout main && git pull");
    expect(e && explanationText(e)).toBe('Pasarse a la rama "main" → Pull en "main"');
    expect(e?.branchDirs).toEqual([]);
    // Even when the branch before it is known: it is not the one pulled into.
    expect(line("git checkout -b feat && git push -u origin HEAD", new Map([["", "dev"]]))).toBe(
      'Crear la rama "feat" y pasarse a ella → Push de "feat"',
    );
    expect(line("git switch - && git push")).toBe("Volver a la rama anterior → Push de la rama actual");
    expect(explainCommand("git switch - && git push")?.branchDirs).toEqual([]);
    expect(line("git checkout abc1234 && git commit -m x")).toBe('Pasarse a "abc1234" (sin rama) → Commit en la rama actual: "x"');
    // Another folder keeps its own branch.
    expect(explainCommand("git checkout main && cd ../x && git push")?.branchDirs).toEqual(["../x"]);
  });

  it("asks for nothing it could only guess", () => {
    expect(explainCommand("cd $PROJECT && git push")?.branchDirs).toEqual([]);
    expect(explainCommand("cd ~ && git push")?.branchDirs).toEqual([]);
    expect(explainCommand("git status")?.branchDirs).toEqual([]);
    // The session's branch is known, but the push happens somewhere else.
    expect(line("cd $PROJECT && git push", new Map([["", "dev"]]))).toBe('Moverse a "$PROJECT" → Push de la rama actual');
  });
});

describe("folders and files", () =>
  table([
    ["cd ../x", 'Moverse a "x"'],
    ["cd C:/Users/manua/Documents/GitHub/panita", 'Moverse a "panita"'],
    [String.raw`cd "C:\Users\manua\My Repo"`, 'Moverse a "My Repo"'],
    ["cd ..", "Subir una carpeta"],
    ["cd ../..", "Subir 2 carpetas"],
    ["cd", "Moverse a la carpeta personal"],
    ["cd ~", "Moverse a la carpeta personal"],
    ["cd -", "Volver a la carpeta anterior"],
    [String.raw`Set-Location -Path C:\repo`, 'Moverse a "repo"'],
    ["rm -rf build", 'Eliminar "build" y todo su contenido', true],
    ["rm -r -f ./build-e2e/", 'Eliminar "build-e2e" y todo su contenido', true],
    ["rm notes.txt", 'Eliminar "notes.txt"'],
    ["rm -f a.txt b.txt", 'Eliminar "a.txt" y "b.txt"'],
    ["rm *.log", 'Eliminar "*.log"', true],
    ["rm -rf /", "Eliminar todo el disco", true],
    ["rm -rf ~", "Eliminar tu carpeta personal y todo su contenido", true],
    ["rm -rf .", "Eliminar la carpeta actual y todo su contenido", true],
    ["rm -rf *", "Eliminar todo lo de la carpeta actual, subcarpetas incluidas", true],
    ["rmdir vacia", 'Eliminar la carpeta "vacia"'],
    ["rmdir /s /q build", 'Eliminar "build" y todo su contenido', true],
    ["rd /s build", 'Eliminar "build" y todo su contenido', true],
    ["del /q notes.txt", 'Eliminar "notes.txt"'],
    ["del /s *.tmp", 'Eliminar "*.tmp" de esta carpeta y sus subcarpetas', true],
    // A backslash inside a Windows path is a separator, not an escape.
    [String.raw`del C:\temp\*.* /q`, 'Eliminar "*.*"', true],
    [String.raw`Remove-Item C:\Users\me\AppData\Local\Temp\x -Recurse`, 'Eliminar "x" y todo su contenido', true],
    ["npx rimraf dist", 'Eliminar "dist" y todo su contenido', true],
    // On Linux a word starting with "/" is a path, not a switch.
    ["rm -rf /tmp/build", 'Eliminar "build" y todo su contenido', true],
    ["rmdir /tmp/empty", 'Eliminar la carpeta "empty"'],
    [String.raw`Remove-Item -Recurse -Force .\dist`, 'Eliminar "dist" y todo su contenido', true],
    ["Remove-Item -Path build -Recurse", 'Eliminar "build" y todo su contenido', true],
    ["Remove-Item notes.txt", 'Eliminar "notes.txt"'],
    ["ri dist -r -fo", 'Eliminar "dist" y todo su contenido', true],
    ['find . -name "*.log" -delete', 'Eliminar los archivos "*.log" que encuentre', true],
    ['find src -name "*.ts"', 'Buscar archivos "*.ts" en "src"'],
    ["mkdir -p src/new/dir", 'Crear la carpeta "dir"'],
    ["mkdir a b", 'Crear las carpetas "a" y "b"'],
    ["md build", 'Crear la carpeta "build"'],
    ["New-Item -ItemType Directory -Path logs", 'Crear la carpeta "logs"'],
    ["ni notes.md", 'Crear el archivo "notes.md"'],
    ["mv old.ts new.ts", 'Renombrar "old.ts" a "new.ts"'],
    ["mv src/old.ts src/new.ts", 'Renombrar "old.ts" a "new.ts"'],
    ["mv a.ts src/", 'Mover "a.ts" a "src"'],
    ["mv a.ts b.ts ../", 'Mover "a.ts" y "b.ts" a la carpeta de arriba'],
    ["Move-Item -Path a.txt -Destination archive\\", 'Mover "a.txt" a "archive"'],
    ["ren a.txt b.txt", 'Renombrar "a.txt" a "b.txt"'],
    ["Rename-Item -Path a.txt -NewName b.txt", 'Renombrar "a.txt" a "b.txt"'],
    ["cp a.txt b.txt", 'Copiar "a.txt" a "b.txt"'],
    ["cp -r src dist", 'Copiar "src" con todo su contenido a "dist"'],
    ["Copy-Item x.json -Destination backup", 'Copiar "x.json" a "backup"'],
    ["robocopy src dst /MIR", 'Copiar "src" a "dst" (espejo: borra lo que sobre en el destino)', true],
    ["touch a.ts", 'Crear el archivo "a.ts"'],
    ["cat package.json", 'Ver "package.json"'],
    ["type README.md", 'Ver "README.md"'],
    ["Get-Content app.log -Tail 20", 'Ver el final de "app.log"'],
    ["head -n 20 log.txt", 'Ver el principio de "log.txt"'],
    ["tail -f app.log", 'Seguir el final de "app.log"'],
    ["tail -n 5 app.log", 'Ver el final de "app.log"'],
    ["ls -la", "Ver los archivos de la carpeta"],
    ["ls src", 'Ver los archivos de "src"'],
    ["dir", "Ver los archivos de la carpeta"],
    ["Get-ChildItem -Path src -Recurse", 'Ver los archivos de "src"'],
    ["pwd", "Ver la carpeta actual"],
    ['grep -rn "TODO" src', 'Buscar "TODO" en "src"'],
    ['rg "fn main"', 'Buscar "fn main"'],
    ["sed -i 's/a/b/' config.yml", 'Editar "config.yml" (reemplazar texto)'],
    ["chmod +x run.sh", 'Cambiar los permisos de "run.sh"'],
    ["tar -xzf release.tar.gz", 'Descomprimir "release.tar.gz"'],
  ]));

describe("packages and runners", () =>
  table([
    ["npm install", "Instalar las dependencias"],
    ["npm i lodash", 'Instalar "lodash"'],
    ["npm install -D vitest @types/node", 'Instalar "vitest" y "@types/node" como dependencia de desarrollo'],
    ["npm install -g pnpm", 'Instalar "pnpm" globalmente'],
    ["npm ci", "Instalar las dependencias exactas del lockfile"],
    ["npm run build", 'Correr el script "build"'],
    ["npm run test:e2e", 'Correr el script "test:e2e"'],
    ["npm test", "Correr los tests"],
    ["npm --prefix windows run build", 'Correr el script "build"'],
    ["npm uninstall lodash", 'Desinstalar "lodash"'],
    ["npm publish", "Publicar el paquete en el registro de npm", true],
    ["pnpm install", "Instalar las dependencias"],
    ["pnpm add zod", 'Instalar "zod"'],
    ["pnpm dev", 'Correr el script "dev"'],
    ["pnpm --filter web build", 'Correr el script "build"'],
    ["yarn", "Instalar las dependencias"],
    ["yarn add react", 'Instalar "react"'],
    ["yarn build", 'Correr el script "build"'],
    ["bun install", "Instalar las dependencias"],
    // npx & co. are explained by the tool they run, when it is known.
    ["npx vitest run", "Correr los tests"],
    ["npx tsc --noEmit -p tests", "Revisar los tipos (TypeScript)"],
    ["pnpm exec prettier --write .", "Formatear el código"],
    ["npx -y create-vite@latest app", 'Ejecutar "create-vite@latest" (paquete de npm)'],
    ["yarn workspace web build", 'Correr el script "build" en "web"'],
    ["yarn workspace web add zod", 'Instalar "zod" en "web"'],
    ["pnpm why react", 'Ver las dependencias instaladas'],
    ["pnpm store prune", null],
    ["pip install --upgrade pip", 'Actualizar "pip" con pip'],
    ["pip install requests", 'Instalar "requests" con pip'],
    ["pip3 install -r requirements.txt", 'Instalar las dependencias de "requirements.txt"'],
    ["python -m pip install -e .", "Instalar el proyecto en modo editable"],
    ["uv pip install httpx", 'Instalar "httpx" con pip'],
    ["pip uninstall -y requests", 'Desinstalar "requests"'],
    ["python script.py", 'Correr "script.py" con Python'],
    ["python3 tools/gen.py --out x", 'Correr "gen.py" con Python'],
    ['python -c "print(1)"', "Correr código Python"],
    ["python -m venv .venv", 'Crear un entorno virtual en ".venv"'],
    ["python3 -m pytest tests/", 'Correr los tests de "tests"'],
    ["pytest -q", "Correr los tests"],
    ["uv run pytest", "Correr los tests"],
    ["uv add fastapi", 'Instalar "fastapi"'],
    ["node scripts/gen-icons.mjs", 'Correr "gen-icons.mjs" con Node'],
    ["tsc --noEmit", "Revisar los tipos (TypeScript)"],
    ["cargo build", "Compilar el proyecto (Rust)"],
    ["cargo build --release", "Compilar el proyecto en release (Rust)"],
    ["cargo test", "Correr los tests (Rust)"],
    ["cargo test -p coucou --lib", 'Correr los tests de "coucou" (Rust)'],
    ["cargo run", "Correr el programa (Rust)"],
    ["cargo clippy -- -D warnings", "Revisar el código con clippy (Rust)"],
    ["make build", 'Correr la tarea "build" (make)'],
    ["docker run -d -p 80:80 nginx", 'Correr un contenedor de "nginx" en segundo plano'],
    ["docker run --rm -it -v $(pwd):/app node:22 bash", 'Correr un contenedor de "node:22"'],
    ["docker run --privileged ubuntu", 'Correr un contenedor de "ubuntu" con todos los privilegios', true],
    ["docker build -t app .", 'Construir la imagen "app"'],
    ["docker build .", "Construir una imagen de Docker"],
    ["docker compose up -d", "Levantar los servicios en segundo plano (docker compose)"],
    ["docker compose -f dev.yml up --build", "Reconstruir y levantar los servicios (docker compose)"],
    ["docker-compose up db", 'Levantar "db" (docker compose)'],
    ["docker compose down", "Bajar los servicios (docker compose)"],
    ["docker compose down -v", "Bajar los servicios y borrar sus volúmenes (docker compose)", true],
    ["docker ps -a", "Ver los contenedores"],
    ["docker logs -f api", 'Ver los logs de "api"'],
    ["docker system prune -af", "Borrar todo lo que Docker no está usando", true],
  ]));

describe("network", () =>
  table([
    ["curl https://api.github.com/repos/x/y", 'Consultar "api.github.com"'],
    ["curl -s localhost:3000/health", 'Consultar "localhost:3000"'],
    ["curl -o out.zip https://example.com/a.zip", 'Descargar "out.zip" de "example.com"'],
    ["curl -LO https://example.com/dl/a.zip", 'Descargar "a.zip" de "example.com"'],
    [`curl -X POST -d '{"a":1}' http://localhost:3000/api`, 'Enviar datos a "localhost:3000"'],
    ["curl -X DELETE https://api.example.com/items/3", 'Borrar algo en "api.example.com"', true],
    ["curl -fsSL https://get.example.sh | sh", 'Consultar "get.example.sh" → Ejecutar lo recibido como un script', true],
    ["wget https://example.com/file.tar.gz", 'Descargar "file.tar.gz" de "example.com"'],
    ["wget -qO- https://example.com/install | bash", 'Consultar "example.com" → Ejecutar lo recibido como un script', true],
    ["Invoke-WebRequest -Uri https://x.com/a.msi -OutFile a.msi", 'Descargar "a.msi" de "x.com"'],
    ["irm https://x.com/install.ps1 | iex", 'Consultar "x.com" → Ejecutar lo recibido como un script', true],
    ["ssh user@server.example.com", 'Conectarse por SSH a "server.example.com"'],
  ]));

describe("processes", () =>
  table([
    ["Get-Process | Where-Object { $_.Name -like 'node*' }", "Ver los procesos"],
    ["tasklist", "Ver los procesos"],
    ["taskkill /F /IM node.exe", 'Terminar el proceso "node.exe"', true],
    ["Stop-Process -Name coucou -Force", 'Terminar el proceso "coucou"', true],
    ["kill -9 1234", 'Terminar el proceso "1234"', true],
    ["sleep 2 && curl localhost:8080", 'Esperar 2 s → Consultar "localhost:8080"'],
    ["where node", 'Ver dónde está "node"'],
    ["Get-ChildItem src | where { $_.Length -gt 0 }", 'Ver los archivos de "src"'],
  ]));

describe("chains", () => {
  table([
    ['cd ../x && git commit -m "fix"', 'Moverse a "x" → Commit en la rama actual: "fix"'],
    ["cd panita; git status", 'Moverse a "panita" → Ver el estado del repo'],
    ["git add . && git commit -m wip && git push", 'Agregar todos los cambios al staging → Commit en la rama actual: "wip" → Push de la rama actual'],
    ["npm install && npm run build || echo failed", 'Instalar las dependencias → Correr el script "build"'],
    ["git log | head -20", "Ver el historial de commits"],
    ["git log --oneline | grep fix", 'Ver el historial de commits → Filtrar por "fix"'],
    ["ls; rm -rf dist", 'Ver los archivos de la carpeta → Eliminar "dist" y todo su contenido', true],
    ["(cd sub && make)", 'Moverse a "sub" → Correr make'],
    ["cd app\nnpm install\nnpm test", 'Moverse a "app" → Instalar las dependencias → Correr los tests'],
    ["frobnicate --all && npm test", "Correr los tests"],
    ["npm test > out.log 2>&1", 'Correr los tests → Escribir en "out.log"'],
    ["npm test 2>/dev/null", "Correr los tests"],
    ["npm test >> log.txt", 'Correr los tests → Agregar al final de "log.txt"'],
    ["npm test | tee out.log", 'Correr los tests → Escribir en "out.log"'],
    ['echo "x" > notes.md', 'Escribir en "notes.md"'],
    ["cat > notes.md <<'EOF'\nrm -rf / && git push --force\nEOF", 'Escribir en "notes.md"'],
    ["git status && echo 'a && rm -rf /'", "Ver el estado del repo"],
    ['bash -c "cd x && npm install"', 'Moverse a "x" → Instalar las dependencias'],
    ['powershell -Command "Remove-Item -Recurse dist"', 'Eliminar "dist" y todo su contenido', true],
    ['cmd /c "rd /s /q build"', 'Eliminar "build" y todo su contenido', true],
    ["sudo rm -rf /var/cache/x", 'Eliminar "x" y todo su contenido (como administrador)', true],
    ["sudo apt install jq", null],
    ["FOO=1 BAR=2 npm test", "Correr los tests"],
    ["env NODE_ENV=production npm run build", 'Correr el script "build"'],
    ["find . -name '*.tmp' | xargs rm -rf", 'Buscar archivos "*.tmp" → Eliminar archivos y carpetas con todo su contenido', true],
    ["for f in *.log; do rm \"$f\"; done", 'Eliminar "$f"'],
    ["& \"C:\\tools\\gh.exe\" pr create --title Hola", 'Crear un pull request: "Hola"'],
  ]);

  it("keeps the order of the parts, and flags each dangerous one", () => {
    const e = explainCommand("cd ../x && rm -rf build && git push --force");
    expect(e?.parts).toEqual([
      { text: 'Moverse a "x"', danger: false },
      { text: 'Eliminar "build" y todo su contenido', danger: true },
      { text: "Push de la rama actual (forzado)", danger: true },
    ]);
    expect(e?.danger).toBe(true);
  });

  it("stops at a dozen parts", () => {
    const e = explainCommand(Array.from({ length: 20 }, (_, i) => `mkdir d${i}`).join(" && "));
    expect(e?.parts).toHaveLength(13);
    expect(e?.parts.at(-1)?.text).toBe("…");
  });
});

describe("what it does not know", () =>
  table([
    ["frobnicate --all", null],
    ["./run.sh", null],
    ["echo hello", null],
    ["", null],
    ["   ", null],
    ["foo | bar && baz; qux", null],
    ["kubectl apply -f deploy.yml", null],
    ["git frobnicate", null],
    ["node", null],
    ["for f in *; do :; done", null],
  ]));

describe("anything's version and help", () =>
  table([
    ["node --version", 'Ver la versión de "node"'],
    ["kubectl version", 'Ver la versión de "kubectl"'],
    ["rustc -V", 'Ver la versión de "rustc"'],
    ["terraform --help", 'Ver la ayuda de "terraform"'],
  ]));

describe("other tools on the approval card", () => {
  const cases: [string, Record<string, unknown>, string | null][] = [
    ["Write", { file_path: String.raw`C:\repo\src\x.ts`, content: "…" }, 'Escribir el archivo "x.ts"'],
    ["Edit", { file_path: "/home/me/app/main.py", old_string: "a", new_string: "b" }, 'Editar el archivo "main.py"'],
    ["MultiEdit", { file_path: "/a/b.rs", edits: [] }, 'Editar el archivo "b.rs"'],
    ["NotebookEdit", { notebook_path: "/a/analysis.ipynb" }, 'Editar el notebook "analysis.ipynb"'],
    ["Read", { file_path: String.raw`C:\repo\.env` }, 'Leer el archivo ".env"'],
    ["WebFetch", { url: "https://docs.rs/tauri/latest", prompt: "x" }, 'Leer la página "docs.rs"'],
    ["WebSearch", { query: "tauri  single\ninstance" }, 'Buscar en la web "tauri single instance"'],
    ["Glob", { pattern: "**/*.ts" }, 'Buscar archivos "**/*.ts"'],
    ["Grep", { pattern: "TODO" }, 'Buscar "TODO" en el código'],
    ["Task", { description: "Explorar el repo", prompt: "…" }, 'Lanzar un subagente: "Explorar el repo"'],
    ["mcp__linear__get_issue", { id: "ABC-1" }, 'Usar "get_issue" (MCP "linear")'],
    ["Bash", { command: "git push origin main:dev" }, 'Push de "main" a "dev"'],
    ["PowerShell", { command: "Remove-Item -Recurse -Force dist" }, 'Eliminar "dist" y todo su contenido'],
    ["Bash", { command: "frobnicate" }, null],
    ["Write", {}, null],
    ["Mystery", { count: 3 }, null],
  ];
  it.each(cases)("%s %j → %s", (tool, input, expected) => {
    const e = explainTool(tool, input);
    expect(e ? explanationText(e) : null).toBe(expected);
  });

  it("passes the branch through to the shell tools", () => {
    const e = explainTool("Bash", { command: 'git commit -m "x"' }, new Map([["", "dev"]]));
    expect(e && explanationText(e)).toBe('Commit en "dev": "x"');
  });
});

describe("cutting a command line", () => {
  const words = (command: string) => splitCommand(command).map((s) => s.words);

  it("splits at && || ; | & and line breaks, never inside quotes", () => {
    expect(words(`a "b && c" && d 'e; f' ; g | h || i & j`)).toEqual([["a", "b && c"], ["d", "e; f"], ["g"], ["h"], ["i"], ["j"]]);
    expect(splitCommand("a | b && c").map((s) => s.joinedBy)).toEqual(["", "|", "&&"]);
    expect(words("a\nb\r\nc")).toEqual([["a"], ["b"], ["c"]]);
  });

  it("keeps $( … ) and backslash-escaped spaces in one word", () => {
    expect(words(`echo $(git rev-parse HEAD && echo x) done`)).toEqual([["echo", "$(git rev-parse HEAD && echo x)", "done"]]);
    expect(words(String.raw`cd My\ Folder`)).toEqual([["cd", "My Folder"]]);
    // A Windows path keeps its backslashes.
    expect(words(String.raw`cd C:\Users\me`)).toEqual([["cd", String.raw`C:\Users\me`]]);
  });

  it("takes redirections out of the words", () => {
    const [s] = splitCommand("npm test > out.log 2>&1 < in.txt");
    expect(s.words).toEqual(["npm", "test"]);
    expect(s.writes).toEqual([{ file: "out.log", append: false }]);
    expect(splitCommand("a 2>> err.log")[0].writes).toEqual([{ file: "err.log", append: true }]);
    expect(splitCommand("a &> all.log")[0].writes).toEqual([{ file: "all.log", append: false }]);
  });

  it("skips a heredoc's text", () => {
    expect(words("cat <<EOF > f\nrm -rf /\nEOF\nls")).toEqual([["cat"], ["ls"]]);
    expect(words("cat <<-'END'\n\trm x\n\tEND\npwd")).toEqual([["cat"], ["pwd"]]);
  });

  it("drops comments and a leading PowerShell call operator", () => {
    expect(words("ls # rm -rf /")).toEqual([["ls"]]);
    expect(words(`& "C:\\Program Files\\Git\\bin\\git.exe" status`)).toEqual([[String.raw`C:\Program Files\Git\bin\git.exe`, "status"]]);
  });
});

describe("reading options", () => {
  it("tells options, their values and arguments apart", () => {
    const a = parseArgs(["-am", "msg", "--author=me", "-v", "file.ts", "--", "-weird"], ["-m", "--author"]);
    expect(a.opt("-m")).toBe("msg");
    expect(a.opt("--author")).toBe("me");
    expect(a.has("-a", "-v")).toBe(true);
    expect(a.positional).toEqual(["file.ts", "-weird"]);
  });

  it("finds a short option inside a cluster, and keeps the case of short ones", () => {
    expect(parseArgs(["-rf", "x"]).has("-r")).toBe(true);
    expect(parseArgs(["-Rf", "x"]).has("-r")).toBe(false);
    expect(parseArgs(["-Rf", "x"]).has("-R")).toBe(true);
    expect(parseArgs(["-d", "x"]).has("-D")).toBe(false);
  });

  it("takes PowerShell's abbreviations and any case for long names", () => {
    expect(parseArgs(["-Rec"]).has("-recurse")).toBe(true);
    expect(parseArgs(["-RECURSE"]).has("-Recurse")).toBe(true);
    expect(parseArgs(["-Path:C:\\x"], ["-Path"]).opt("-path")).toBe("C:\\x");
  });
});

describe("resolving a branch folder", () => {
  it("joins a cd onto a Windows session's folder", () => {
    const cwd = String.raw`C:\Users\me\repos\panita\windows`;
    expect(resolveFolder(cwd, "", false)).toBe(cwd);
    expect(resolveFolder(cwd, "../x", false)).toBe(String.raw`C:\Users\me\repos\panita\x`);
    expect(resolveFolder(cwd, "a/b/..", false)).toBe(String.raw`C:\Users\me\repos\panita\windows\a`);
    expect(resolveFolder(cwd, "D:/work/y", false)).toBe(String.raw`D:\work\y`);
    expect(resolveFolder(cwd, "/c/Users/me/z", false)).toBe(String.raw`C:\Users\me\z`);
    expect(resolveFolder(cwd, "/top", false)).toBe(String.raw`C:\top`);
    expect(resolveFolder(cwd, "../../../../../../..", false)).toBe("C:\\");
    expect(resolveFolder(String.raw`\\server\share\proj`, "../other", false)).toBe(String.raw`\\server\share\other`);
    expect(resolveFolder("relative", "", false)).toBeNull();
    expect(resolveFolder("", "", false)).toBeNull();
  });

  it("and onto a WSL session's Linux folder", () => {
    expect(resolveFolder("/home/me/struxto", "", true)).toBe("/home/me/struxto");
    expect(resolveFolder("/home/me/struxto", "../infra", true)).toBe("/home/me/infra");
    expect(resolveFolder("/home/me/struxto", "/opt/x/./y", true)).toBe("/opt/x/y");
    expect(resolveFolder(String.raw`C:\x`, "", true)).toBeNull();
  });
});

describe("commit messages", () => {
  it("the first line, from -m or a heredoc", () => {
    expect(messageTitle("fix")).toBe("fix");
    expect(messageTitle("  \nTitle\nbody")).toBe("Title");
    expect(messageTitle("$(cat <<'EOF'\nTítulo\n\ncuerpo\nEOF\n)")).toBe("Título");
    expect(messageTitle('$(cat <<"EOF"\nT2\nEOF\n)')).toBe("T2");
  });
});
