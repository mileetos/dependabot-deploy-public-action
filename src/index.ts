import * as core from '@actions/core';
import { GitHub, context } from '@actions/github';
import { WebhookPayloadStatus } from '@octokit/webhooks';
import moment from 'moment-timezone';
import { VersionType, InputParams, DeployDependencies } from './types';
import { getVersionTypeChangeFromTitle } from './utils/getVersionTypeChangeFromTitle';
import {
  isInProdDependencies,
  isInAnyDependencies,
  isInDevDependencies,
} from './utils/packageJson';
import { deploy } from './deploy';
import { isSuccessStatusCode } from './utils';
import { addReview } from './review';
import { isWorkingHour } from './utils/isWorkingHour';
import { getPackageNameFromTitle } from './utils/getPackageNameFromTitle';
import { isMergeableDevDependency } from './utils/isMergeableDevDependency';
import { mergeToMaster } from './merge';

const DEPLOY_DEPENDENCIES = ['dev', 'all'];
const VERSION_TYPES = ['PATCH', 'MINOR', 'MAJOR'];
const DEPENDABOT_BRANCH_PREFIX = 'dependabot';
const EXPECTED_CONCLUSION = 'success';
const EXPECTED_CONTEXT = 'continuous-integration/codeship';
const DEPENDABOT_LABEL = 'dependencies';

const getInputParams = (): InputParams => {
  const deployDependencies = core.getInput('deployDependencies') as DeployDependencies;
  const updateIndirectDependencies = Boolean(core.getInput('updateIndirectDependencies'));
  const gitHubToken = core.getInput('gitHubToken');
  const deployOnlyInWorkingHours = Boolean(core.getInput('deployOnlyInWorkingHours'));
  const timezone = core.getInput('timezone');
  const maxDeployVersion = core.getInput('maxDeployVersion').toUpperCase() as VersionType;

  const isValidTimezone = moment.tz.zone(timezone);
  if (!isValidTimezone) {
    throw new Error(
      `Unexpected input ${timezone} for timezone. Please check https://momentjs.com/timezone/ for list of valid timezones`,
    );
  }

  if (!VERSION_TYPES.includes(maxDeployVersion)) {
    throw new Error(`Unexpected input for maxDeployVersion ${maxDeployVersion}`);
  }

  if (!DEPLOY_DEPENDENCIES.includes(deployDependencies)) {
    throw new Error(`Unexpected input for deployDependencies ${deployDependencies}`);
  }

  return {
    deployDependencies,
    updateIndirectDependencies,
    gitHubToken,
    maxDeployVersion,
    deployOnlyInWorkingHours,
    timezone,
  };
};

const shouldDeployBranch = (branchName: string): boolean =>
  branchName.startsWith(DEPENDABOT_BRANCH_PREFIX);

const shouldDeployLabel = (labels: string[]): boolean => labels.includes(DEPENDABOT_LABEL);

const shouldDeployVersion = (
  versionChangeType: VersionType,
  maxDeployVersion: VersionType,
): boolean => {
  const versionIndex = VERSION_TYPES.indexOf(versionChangeType);
  const maxVersionIndex = VERSION_TYPES.indexOf(maxDeployVersion);

  return versionIndex <= maxVersionIndex;
};

const isAllowedToDeployNow = (deployOnlyInWorkingHours: boolean, timezone: string) => {
  if (!deployOnlyInWorkingHours) {
    return true;
  }

  const now = moment.tz(timezone);

  return isWorkingHour(now);
};

const run = async (payload: WebhookPayloadStatus): Promise<void> => {
  const input = getInputParams();
  const client = new GitHub(input.gitHubToken);

  if (payload.context !== EXPECTED_CONTEXT) {
    console.log('Context is not codeship, skipping');
    return;
  }

  console.log('PAYLOAD', payload);

  const isSuccess = payload.state === EXPECTED_CONCLUSION;
  if (!isSuccess) {
    console.log('Status is not success, skipping');
    return;
  }

  if (payload.branches.length !== 1) {
    console.log('DEBUG: payload.branches array', JSON.stringify(payload.branches));
    throw new Error(
      `Length of payload.branches array is different than expected. Length: ${payload.branches.length}`,
    );
  }

  const branch = payload.branches[0];

  if (!shouldDeployBranch(branch.name)) {
    throw new Error(`Branch had an unexpected name ${branch}`);
  }

  const pullRequests = await client.pulls.list({
    direction: 'desc',
    sort: 'updated',
    state: 'open',
    repo: context.repo.repo,
    owner: context.repo.owner,
  });

  if (!isSuccessStatusCode(pullRequests.status)) {
    throw new Error('PRs could not be listed');
  }

  const validPullRequests = pullRequests.data.filter(
    (e) =>
      e.head.ref === branch.name && e.base.ref === 'master' && e.head.sha === branch.commit.sha,
  );

  if (validPullRequests.length !== 1) {
    console.log('DEBUG: pullRequest array', JSON.stringify(validPullRequests));
    throw new Error(
      `Length of validPullRequests array is different than expected. Length: ${validPullRequests.length}`,
    );
  }

  const pullRequest = validPullRequests[0];

  console.log(`Found PR ${pullRequest.number} for deploy`);

  const listParams = {
    pull_number: pullRequest.number,
    repo: context.repo.repo,
    owner: context.repo.owner,
  };

  const [commits, comments, reviews] = await Promise.all([
    client.pulls.listCommits(listParams),
    client.pulls.listComments(listParams),
    client.pulls.listReviews(listParams),
  ]);

  if (commits.data.length > 1 || comments.data.length > 0 || reviews.data.length > 0) {
    console.log(
      `Found interaction with the PR. Skipping. Commits: ${commits.data.length}, Comments: ${comments.data.length}, Reviews: ${reviews.data.length}`,
    );
    return;
  }

  if (!commits.data[0].commit.author.name.toLowerCase().startsWith('dependabot')) {
    console.log(
      `First commit not from dependabot. Commit author: ${commits.data[0].commit.author.name}`,
    );
    return;
  }

  const versionChangeType = getVersionTypeChangeFromTitle(pullRequest.title);

  if (!shouldDeployVersion(versionChangeType, input.maxDeployVersion)) {
    console.log(
      `Skipping deploy for version type ${versionChangeType}. Running with maxDeployVersion ${input.maxDeployVersion}`,
    );
    return;
  }

  const labels = pullRequest.labels.map((e) => e.name);
  if (!shouldDeployLabel(labels)) {
    console.log(`Skipping deploy. PRs with Labels "${labels}" should not be deployed`);
    return;
  }

  const packageName = getPackageNameFromTitle(pullRequest.title);

  if (input.deployDependencies === 'dev' && isInProdDependencies(packageName)) {
    console.log(`Skipping deploy. Package ${packageName} found in prod dependencies`);
    return;
  }

  if (!input.updateIndirectDependencies && !isInAnyDependencies(packageName)) {
    console.log(`Skipping deploy. Package ${packageName} not found in any dependencies`);
    return;
  }

  await addReview(pullRequest.number, context, client);

  if (isInDevDependencies(packageName) && isMergeableDevDependency(packageName)) {
    console.log(`Merging dependency without deploy. Package ${packageName}`);
    const wasMerged = await mergeToMaster(pullRequest.number, context, client);
    if (wasMerged) {
      return;
    }
  }

  if (isAllowedToDeployNow(input.deployOnlyInWorkingHours, input.timezone)) {
    await deploy(pullRequest.number, context, client);
  } else {
    console.log('Skipping deploy outside of working hours');
  }
};

try {
  if (context.eventName === 'status') {
    run(context.payload as WebhookPayloadStatus);
  } else {
    console.log(`Not running for event ${context.eventName} and action ${context.action}`);
  }
} catch (error) {
  core.setFailed(error.message);
}
