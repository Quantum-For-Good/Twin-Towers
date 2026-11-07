import { buildServer } from './server.js';
import { Pool } from 'pg';
import { PostgresConsentRepository } from './consent-repository.js';
import { PostgresDataSharingRepository } from './data-sharing-repository.js';
import { PostgresDeviceRepository } from './device-repository.js';
import { PostgresMetadataRepository } from './metadata-repository.js';
import { runMigrations } from './migrations.js';

async function start() {
  const databaseUrl = process.env.KICKS_DATABASE_URL;
  if (process.env.NODE_ENV === 'production' && !databaseUrl) {
    throw new Error('KICKS_DATABASE_URL_required_in_production');
  }

  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
  if (pool) await runMigrations(pool);

  const app = buildServer(pool ? {
    deviceRepository: new PostgresDeviceRepository(pool),
    consentRepository: new PostgresConsentRepository(pool),
    metadataRepository: new PostgresMetadataRepository(pool),
    dataSharingRepository: new PostgresDataSharingRepository(pool),
    phase0PostgresAuthorization: true
  } : {});
  if (pool) app.addHook('onClose', async () => { await pool.end(); });
  try {
    await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
  } catch (error) {
    await app.close();
    throw error;
  }
}

start().catch(error => {
  console.error('KICKS API startup failed', error);
  process.exitCode = 1;
});
