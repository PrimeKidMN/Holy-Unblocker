import { readFile, writeFile, unlink, mkdir, rm } from 'node:fs/promises';
import { exec, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ecosystem from './ecosystem.config.js';

const config = Object.freeze(
    JSON.parse(await readFile(new URL('./config.json', import.meta.url)))
  ),
  ecosystemConfig = Object.freeze(
    ecosystem.apps.find((app) => app.name === 'HolyUB') || ecosystem.apps[0]
  );

const serverUrl = ((base) => {
  try {
    base = new URL(config.host);
  } catch (e) {
    base = new URL('http://a');
    base.host = config.host;
  }
  base.port =
    ecosystemConfig[config.production ? 'env_production' : 'env'].PORT;
  return Object.freeze(base);
})();

const shutdown = fileURLToPath(new URL('./src/.shutdown', import.meta.url));

commands: for (let i = 2; i < process.argv.length; i++) {
  switch (process.argv[i]) {
    case 'start':
      if (config.production) {
        exec('npx pm2 start ecosystem.config.js --env production', (error, stdout) => {
          if (error) throw error;
          console.log(stdout);
        });
      } else if (process.platform === 'win32') {
        exec('START /MIN "" node backend.js', (error, stdout) => {
          if (error) {
            console.error(error);
            process.exitCode = 1;
          }
          console.log(stdout);
        });
      } else {
        const server = fork(fileURLToPath(new URL('./backend.js', import.meta.url)), {
          cwd: process.cwd(),
          detached: true,
        });
        server.unref();
        server.disconnect();
      }
      break;

    case 'stop': {
      await writeFile(shutdown, '');
      let timeoutId;
      try {
        const response = await Promise.race([
          fetch(new URL('/test-shutdown', serverUrl)),
          new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve('Error'), 5000);
          }),
        ]);
        clearTimeout(timeoutId);
        if (response === 'Error') throw new Error('Server is unresponsive.');
      } catch (e) {
        await unlink(shutdown);
        if (!(e instanceof TypeError)) {
          console.error(e);
          process.exitCode = 1;
          break commands;
        }
      }
      if (config.production) {
        exec('npx pm2 stop ecosystem.config.js', (error, stdout) => {
          if (error) console.error(error);
          console.log(stdout);
        });
      }
      break;
    }

    case 'build': {
      const dist = fileURLToPath(new URL('./views/dist', import.meta.url));
      await rm(dist, { force: true, recursive: true });
      await mkdir(dist, { recursive: true });
      console.log('Build directory prepared.');
      break;
    }

    case 'kill':
      if (process.platform === 'win32') {
        exec('( npx pm2 delete ecosystem.config.js ) & taskkill /F /IM node*', (error, stdout) => {
          console.log(stdout);
        });
      } else {
        exec('npx pm2 delete ecosystem.config.js; pkill node', (error, stdout) => {
          console.log(stdout);
        });
      }
      break;

    case 'workflow': {
      const tempServer = fork(fileURLToPath(new URL('./backend.js', import.meta.url)), {
        cwd: process.cwd(),
        stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
        detached: true,
      });
      tempServer.stderr.on('data', (stderr) => {
        if (!stderr.toString().includes('DeprecationWarning')) {
          console.error(stderr.toString());
          tempServer.kill();
          process.exitCode = 1;
        }
      });
      tempServer.stdout.on('data', () => {
        tempServer.kill();
        const server = fork(fileURLToPath(new URL('./backend.js', import.meta.url)), {
          cwd: process.cwd(),
          stdio: 'ignore',
          detached: true,
        });
        server.unref();
        server.disconnect();
      });
      tempServer.unref();
      tempServer.disconnect();
      break;
    }
  }
}

process.exitCode = process.exitCode || 0;
