import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findWake, greetingFor, interpretCommand, isEcho } from '../public/js/skills.js';

const first = (options) => options[0];

test('findWake detects "Hey Jarvis" and returns the rest of the sentence', () => {
  assert.deepEqual(findWake('Hey Jarvis, what is the capital of France?'), {
    phrase: 'Hey Jarvis,',
    remainder: 'what is the capital of France?',
  });
  assert.equal(findWake('jarvis what time is it').remainder, 'what time is it');
  assert.equal(findWake('OK Jarvis').remainder, '');
  assert.equal(findWake('hey jervis who won the game').remainder, 'who won the game');
  assert.equal(findWake('hey Travis how tall is Everest').remainder, 'how tall is Everest');
});

test('findWake ignores speech without the wake word', () => {
  assert.equal(findWake('what is the capital of France'), null);
  assert.equal(findWake('Travis Scott released an album'), null);
  assert.equal(findWake('the jarvisian era'), null);
});

test('isEcho recognises Jarvis hearing itself', () => {
  const spoken = 'Good evening, sir. Jarvis is online. Say "Hey Jarvis" whenever you need me.';
  assert.equal(isEcho('hey Jarvis', spoken), true);
  assert.equal(isEcho('hey Jarvis stop', spoken), false);
  assert.equal(isEcho('hey Jarvis', ''), false);
});

test('interpretCommand handles stop words', () => {
  for (const text of ['stop', 'Cancel.', 'never mind', 'please stop', "that's all"]) {
    assert.deepEqual(interpretCommand(text), { type: 'stop' }, text);
  }
});

test('interpretCommand answers the time and date locally', () => {
  const now = new Date(2026, 8, 30, 16, 5);
  const time = interpretCommand('What time is it?', { now, honorific: 'sir' });
  assert.equal(time.type, 'reply');
  assert.match(time.text, /^It's 4:05\s?PM, sir\.$/);

  const date = interpretCommand("what's the date today", { now });
  assert.equal(date.type, 'reply');
  assert.match(date.text, /Wednesday, September 30, 2026/);
});

test('interpretCommand sends "time in <place>" to search instead of the local clock', () => {
  assert.deepEqual(interpretCommand('what time is it in Tokyo'), { type: 'search', query: 'what time is it in Tokyo' });
});

test('interpretCommand strips search prefixes but keeps the original casing', () => {
  assert.deepEqual(interpretCommand('Search Google for Stark Industries'), { type: 'search', query: 'Stark Industries' });
  assert.deepEqual(interpretCommand('look up the Mark 42 armor please'), { type: 'search', query: 'the Mark 42 armor' });
  assert.deepEqual(interpretCommand('Tell me about Pepper Potts.'), { type: 'search', query: 'Pepper Potts' });
});

test('interpretCommand passes plain questions straight to search', () => {
  assert.deepEqual(interpretCommand('Who directed Iron Man?'), { type: 'search', query: 'Who directed Iron Man?' });
});

test('small talk respects the chosen honorific', () => {
  assert.equal(interpretCommand('thank you', { pick: first, honorific: 'boss' }).text, "You're welcome, boss.");
  assert.equal(interpretCommand('hello', { pick: first, honorific: '' }).text, 'Hello. How can I help?');
  assert.equal(interpretCommand('who are you').type, 'reply');
});

test('greetingFor matches the time of day', () => {
  assert.match(greetingFor(new Date(2026, 0, 1, 9), 'sir'), /^Good morning, sir\./);
  assert.match(greetingFor(new Date(2026, 0, 1, 14), ''), /^Good afternoon\./);
  assert.match(greetingFor(new Date(2026, 0, 1, 21), 'sir', { voice: false }), /Type a question/);
});
