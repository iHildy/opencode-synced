import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readProjectFile = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const publishWorkflow = readProjectFile('.github/workflows/publish.yml');
const releaseWorkflow = readProjectFile('.github/workflows/release.yml');
const smokeWorkflow = readProjectFile('.github/workflows/opencode-smoke.yml');

describe('release workflows', () => {
  it('uses one stable release-please configuration', () => {
    const config = JSON.parse(readProjectFile('release-please-config.json')) as Record<
      string,
      unknown
    >;

    expect(config['release-type']).toBe('node');
    expect(config.prerelease).toBeUndefined();
    expect(config.versioning).toBeUndefined();
    expect(releaseWorkflow).toContain('googleapis/release-please-action@');
    expect(releaseWorkflow).not.toContain('google-github-actions/release-please-action@');
    expect(releaseWorkflow).not.toContain('release-type: node');
  });

  it('pins external actions to full commit SHAs', () => {
    const workflows = [publishWorkflow, releaseWorkflow, smokeWorkflow];
    const externalUses = workflows.flatMap((workflow) =>
      [...workflow.matchAll(/uses:\s+([^\s]+)/g)]
        .map((match) => match[1])
        .filter((value): value is string => Boolean(value) && !value.startsWith('./'))
    );

    expect(externalUses.length).toBeGreaterThan(0);
    for (const action of externalUses) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('fails closed around canonical publish refs and OIDC', () => {
    expect(publishWorkflow).toContain("description: 'Exact full commit SHA to publish'");
    expect(publishWorkflow).toContain('Publishing requires a full commit SHA.');
    expect(publishWorkflow).toContain('Latest publishing requires the commit behind');
    expect(publishWorkflow).toContain(
      'Next publishing requires the exact SHA of the open release-please PR.'
    );
    expect(publishWorkflow).toContain('persist-credentials: false');
    expect(publishWorkflow).toContain('id-token: write');
    expect(publishWorkflow).not.toContain('simenandre/setup-inputs');
    expect(publishWorkflow).not.toContain('npm dist-tag');
    expect(publishWorkflow).not.toContain('continue-on-error');
  });

  it('smokes the exact artifact before and after direct publication', () => {
    expect(publishWorkflow).toContain('prepublish-smoke:');
    expect(publishWorkflow).toContain('postpublish-smoke:');
    expect(publishWorkflow).toContain('npm publish "$TARBALL"');
    expect(smokeWorkflow).toContain('spec=opencode-synced@file:$TARBALL');
    expect(smokeWorkflow).toContain('Expected exact version $REQUESTED_VERSION');
  });

  it('uses string comparisons for release-please boolean outputs and frozen setup', () => {
    expect(releaseWorkflow).toContain("outputs.releases_created == 'true'");
    expect(releaseWorkflow).toContain("outputs.prs_created == 'true'");
    expect(readProjectFile('.mise/tasks/setup')).toContain('bun install --frozen-lockfile');
  });
});
