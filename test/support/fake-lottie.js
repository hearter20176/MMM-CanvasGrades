"use strict";

// Fake lottie-web global for tests. Records every player so tests can assert how many were
// created, how many are still live, and what state they are in.

function createFakeLottie() {
	const lottie = {
		players: [],
		created: 0,
		throwOnLoad: false,
		loadAnimation(opts) {
			if (lottie.throwOnLoad) throw new Error("fake lottie failure");
			const listeners = {};
			const player = {
				opts,
				destroyed: false,
				playing: true,
				plays: 0,
				pauses: 0,
				listeners,
				play() {
					player.playing = true;
					player.plays++;
				},
				pause() {
					player.playing = false;
					player.pauses++;
				},
				destroy() {
					player.destroyed = true;
					player.playing = false;
				},
				addEventListener(name, fn) {
					listeners[name] = fn;
				}
			};
			lottie.created++;
			lottie.players.push(player);
			return player;
		},
		live() {
			return lottie.players.filter((p) => !p.destroyed);
		}
	};
	return lottie;
}

module.exports = { createFakeLottie };
