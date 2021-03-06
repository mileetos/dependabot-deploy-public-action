#

# Dependabot Minor Updates Deploy GitHub action - IN TESTING

Forked from the Github Action created by our wonderful Prague colleagues.

A GitHub Action which allows to deploy Pipedrive services. Needs developer approval and reconciles previous updates before adding ready-for-deploy label.

## Usage

Create an yml file into `.github/workflows/<WORKFLOW_NAME>.yml` and merge into into your default branch (usually master). This action needs to contain the `checkout` action. This action uses it to verify if the package which is being updated is in dev/prod dependencies.

```yml
on: [status]

jobs:
  deploy:
    runs-on: ubuntu-latest
    name: Dependabot auto deploy dependencies
    steps:
      - name: Checkout
        uses: actions/checkout@v2
      - name: Deploy
        uses: pipedrive/dependabot-deploy-minor-changes@master
        with:
          gitHubToken: ${{ secrets.GITHUB_TOKEN }}
```

### Inputs

#### gitHubToken (required)

GitHub token for current action.

#### maxDeployVersion

The maximum difference in version which should be auto-deployed. Allowed values `PATCH`, `MINOR`, `MAJOR`. Defaults to `MAJOR`.

#### deployOnlyInWorkingHours

If true then deploy will be skipped if the PR is created outside of working hours". Default `true`. Working hours are defined as Monday-Friday 07:00 - 16:59

#### timezone

Timezone defined https://momentjs.com/timezone/ used to verify if the current time is within the working hours. Default `Europe/Prague`

#### deployDependencies

Defines what dependencies should be deployed. Either `dev` or `all`. Default `dev`

#### updateIndirectDependencies

Defines whether to deploy indirect dependencies (dependencies of dependencies). Either `true` or `false`. Default `false`

### Development

To install all dependencies run:

```sh
npm install
```

The package is built into single `dist/index.js` file which is part of the repository. It needs to be created manually before the commit by running:

```sh
# Run all tests and creates the build
npm run publish
```
