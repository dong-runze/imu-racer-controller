/**
 * rollup config based on generator: https://github.com/sveltejs/template/blob/master/rollup.config.js
 */

import svelte from 'rollup-plugin-svelte';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import livereload from 'rollup-plugin-livereload';
import { terser } from 'rollup-plugin-terser';
import preprocess from 'svelte-preprocess';
import css from 'rollup-plugin-css-only';
import scss from 'rollup-plugin-scss';
import sass from 'sass';

const production = !process.env.ROLLUP_WATCH;

function serve() {
	let server;

	function toExit() {
		if (server) server.kill(0);
	}

	return {
		writeBundle() {
			if (server) return;
			server = require('child_process').spawn('npm', ['run', 'start', '--', '--dev'], {
				stdio: ['ignore', 'inherit', 'inherit'],
				shell: true
			});

			process.on('SIGTERM', toExit);
			process.on('exit', toExit);
		}
	};
}

function createConfig({ input, name, file, cssFile, enableServe = false }) {
	return {
		input,
		output: {
			sourcemap: true,
			format: 'iife',
			name,
			file
		},
		plugins: [
			svelte({
				compilerOptions: {
					dev: !production
				},
				preprocess: preprocess({
					scss: {
						implementation: sass
					}
				})
			}),
			scss({
				sass
			}),
			css({ output: cssFile }),
			resolve({
				browser: true,
				dedupe: ['svelte']
			}),
			commonjs(),
			!production && enableServe && serve(),
			!production && livereload('src'),
			production && terser()
		],
		watch: {
			clearScreen: false
		}
	};
}

export default [
	createConfig({
		input: 'src/main.js',
		name: 'app',
		file: 'public/build/bundle.js',
		cssFile: 'bundle.css',
		enableServe: true
	}),
	createConfig({
		input: 'src/trainerMain.js',
		name: 'trainer',
		file: 'public/build/trainer.js',
		cssFile: 'trainer.css'
	})
];
