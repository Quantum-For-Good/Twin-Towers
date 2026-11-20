# Disposable PostgreSQL runbook (Windows, D: drive)

This runbook provisions a new, isolated PostgreSQL cluster on the designated
D: drive for the API integration test. It is not a staging or production
procedure.

## Safety conditions

- Use only `D:\KICKS\postgres-disposable` for this disposable cluster.
- Never connect to, stop, reconfigure, or alter the existing PostgreSQL instance
  or anything on port `5432`.
- The test endpoint is fixed at `127.0.0.1:5433/kicks_disposable_test`. If port
  `5433` is already listening, stop and ask the environment owner; do not use
  that listener, choose a different port, or weaken the test URL guard.
- If `D:\KICKS\postgres-disposable` already exists, stop. Do not reuse, clear,
  or delete it without the owner verifying that it is this disposable cluster.
- Do not set `KICKS_DATABASE_URL` for this procedure. Do not put test credentials
  in a committed file, shell profile, deployment setting, or production secret.
- The test only creates and drops uniquely named schemas inside the named test
  database. Do not run these commands against any other database.

## Create the disposable cluster

Open PowerShell as the ordinary account that will run the test. Set the
PostgreSQL `bin` path to the locally installed version; this runbook does not
install PostgreSQL or alter a Windows service.

```powershell
$ErrorActionPreference = 'Stop'
$PgBin = 'C:\Program Files\PostgreSQL\17\bin'
$Root = 'D:\KICKS\postgres-disposable'
$DataDir = Join-Path $Root 'data'

if (Test-Path $Root) {
  throw 'Disposable cluster path already exists; stop and have the owner verify it.'
}
if (Get-NetTCPConnection -LocalPort 5433 -State Listen -ErrorAction SilentlyContinue) {
  throw 'Port 5433 is already listening; stop and ask the environment owner.'
}
if (-not (Test-Path (Join-Path $PgBin 'initdb.exe'))) {
  throw 'Set $PgBin to the installed PostgreSQL bin directory.'
}

New-Item -ItemType Directory -Path $Root | Out-Null
& (Join-Path $PgBin 'initdb.exe') -D $DataDir -U kicks_disposable_admin `
  --auth-local=scram-sha-256 --auth-host=scram-sha-256 -W
if ($LASTEXITCODE -ne 0) { throw 'initdb failed; do not continue.' }

Add-Content -LiteralPath (Join-Path $DataDir 'postgresql.conf') `
  -Value "`nport = 5433`nlisten_addresses = '127.0.0.1'`n"
& (Join-Path $PgBin 'pg_ctl.exe') -D $DataDir `
  -l (Join-Path $Root 'postgres.log') -o '-h 127.0.0.1 -p 5433' -w start
if ($LASTEXITCODE -ne 0) { throw 'Disposable cluster failed to start; do not continue.' }
```

`initdb` prompts for a password for the disposable cluster administrator. Create
a separate URL-safe password containing only letters and digits for the
`kicks_test` role. Keep both out of source control and use them only for this
local disposable cluster.

```powershell
& (Join-Path $PgBin 'createuser.exe') --host=127.0.0.1 --port=5433 `
  --username=kicks_disposable_admin --password --no-superuser --no-createdb `
  --no-createrole --pwprompt kicks_test
if ($LASTEXITCODE -ne 0) { throw 'createuser failed; do not continue.' }

& (Join-Path $PgBin 'createdb.exe') --host=127.0.0.1 --port=5433 `
  --username=kicks_disposable_admin --password --owner=kicks_test `
  kicks_disposable_test
if ($LASTEXITCODE -ne 0) { throw 'createdb failed; do not continue.' }
```

The commands prompt for the administrator and test-role passwords. Do not place
either password directly in a command-line argument.

## Run and record the integration test

From the repository root, set the URL for the local test process only. Replace
`<URL-safe-password>` below with the `kicks_test` password chosen above; do not
copy the placeholder literally.

```powershell
$TestUrl = 'postgresql://kicks_test:<URL-safe-password>@127.0.0.1:5433/kicks_disposable_test'
$env:KICKS_DISPOSABLE_DATABASE_URL = $TestUrl

npm ci
npm run typecheck
npm run test --workspace @kicks/api
```

The database URL guard rejects other hosts, ports, database names, and URL
parameters. Record the tested commit, PostgreSQL version, command, and test
summary; do not include the URL or the password in the evidence. A skipped
integration test is not a pass.

After the run, clear the process environment and stop only this new cluster:

```powershell
Remove-Item Env:\KICKS_DISPOSABLE_DATABASE_URL -ErrorAction SilentlyContinue
& (Join-Path $PgBin 'pg_ctl.exe') -D $DataDir -m fast -w stop
```

Do not delete the data directory as part of this test procedure. Staging
deployment, staging smoke tests, and access to any existing database are outside
the runbook.
