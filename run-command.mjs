import { readFile, writeFile, unlink, mkdir, rm } from 'node:fs/promises';
import { exec, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ecosystem from './ecosystem.config.js';

const config = Object.freeze(
    JSON.parse(await readFile(new URL('./config.json', import.meta.url)))
);
const ecosystemConfig = Object.freeze(
    ecosystem.apps.find((app) => app.name === 'HolyUB') || ecosystem.apps[0]
);

const serverUrl = (() => {
    try {
        return new URL(config.host);
    } catch (e) {
        const base = new URL('http://a');
        base.host = config.host;
        base.port = ecosystemConfig[config.production ? 'env_production' : 'env'].PORT;
        return Object.freeze(base);
    }
})();

const shutdown = fileURLToPath(new URL('./src/.shutdown', import.meta.url));

const runCommand = async (command) => {
    try {
        switch (command) {
            case 'start':
                if (config.production) {
                    exec('npx pm2 start ecosystem.config.js --env production', logExec);
                } else {
                    const cmd = process.platform === 'win32' ? 'start /B node backend.js' : 'nohup node backend.js &';
                    exec(cmd, logExec);
                }
                break;

            case 'stop':
                await writeFile(shutdown, '');
                try {
                    const response = await fetch(new URL('/test-shutdown', serverUrl));
                    if (!response.ok) throw new Error('Server response error.');
                } catch (e) {
                    await unlink(shutdown);
                    console.error(e);
                    process.exitCode = 1;
                    return;
                }
                if (config.production) exec('npx pm2 stop ecosystem.config.js', logExec);
                break;

            case 'build':
                const dist = fileURLToPath(new URL('./views/dist', import.meta.url));
                await rm(dist, { force: true, recursive: true });
                await mkdir(dist, { recursive: true });
                await build({
                    entryPoints: ['./views/uv/**/*.js', './views/scram/**/*.js', './views/assets/js/**/*.js', './views/assets/css/**/*.css'],
                    platform: 'browser',
                    sourcemap: true,
                    bundle: true,
                    minify: true,
                    external: ['*.png', '*.jpg', '*.jpeg', '*.webp', '*.svg'],
                    outdir: dist,
                });
                break;

            case 'kill':
                const killCmd = process.platform === 'win32' ? '( npx pm2 delete ecosystem.config.js ) & taskkill /F /IM node.exe' : 'npx pm2 delete ecosystem.config.js && pkill node';
                exec(killCmd, logExec);
                break;

            case 'workflow':
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
                    const server = fork(fileURLToPath(new URL('./backend.js', import.meta.url)), { stdio: 'ignore', detached: true });
                    server.unref();
                });
                tempServer.unref();
                break;
        }
    } catch (error) {
        console.error(`Error executing command ${command}:`, error);
        process.exitCode = 1;
    }
};

const logExec = (error, stdout) => {
    if (error) console.error(error);
    console.log(stdout);
};

for (const arg of process.argv.slice(2)) {
    await runCommand(arg);
}

process.exitCode = process.exitCode || 0;
