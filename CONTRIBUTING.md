### I'm having an issue:

1. Search [issues](https://github.com/veliovgroup/mail-time/issues?utf8=✓&q=is%3Aissue), maybe your issue is already solved
2. Before submitting an issue make sure it's only related to `mail-time` package
3. If your issue is not solved:
   - Give an expressive description of what is went wrong
   - Version of `mail-time` you're experiencing this issue
   - Version of `Node.js` and `NPM` you're experiencing this issue
   - If you're getting an error (exception), please provide full error log (output in console) as file or screenshot

### Running the tests locally:

1. `npm install`, then `npm run test:jest` (unit, no databases) and `npm run test:types`
2. `docker compose up -d` starts Redis, MongoDB and PostgreSQL with the images CI uses; `npm run test:mocha:local` runs the integration suites against them (`docker compose down -v` to clean up)
3. `npm run test:pack` verifies the published package shape from a scratch consumer project (ESM, CJS, subpaths, TypeScript)
4. Before a release: `npm run prepublishOnly` regenerates `index.cjs` and the declaration files; commit them

### I have a suggestion:

1. PRs are always welcome - [send a PR](https://github.com/veliovgroup/mail-time/compare)
2. If you're can not send a PR for some reason:
   - Create a new issue ticket
   - Describe your feature / request
   - How you're going to use it? Give a usage example(s)

### Documentation is missing something or incorrect (have typos, etc.):

1. PRs are always welcome - [send a PR](https://github.com/veliovgroup/mail-time/compare)
2. If you're can not send a PR to docs for some reason:
   - Create a new issue ticket
   - Give a short description what you have changed/added and why
   - Make sure you're using correct markdown markup
   - Make sure all code blocks starts with triple ``` (*backtick*) and have a syntax tag, for more read [this docs](https://help.github.com/articles/creating-and-highlighting-code-blocks/#syntax-highlighting)
   - Post addition/changes as issue ticket, we will manage it
