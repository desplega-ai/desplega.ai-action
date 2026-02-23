# desplega.ai GitHub Action!

[![GitHub Super-Linter](https://github.com/desplega-ai/desplega.ai-action/actions/workflows/linter.yml/badge.svg)](https://github.com/desplega-ai/desplega.ai-action/actions/workflows/linter.yml)
![CI](https://github.com/desplega-ai/desplega.ai-action/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/desplega-ai/desplega.ai-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/desplega-ai/desplega.ai-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/desplega-ai/desplega.ai-action/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/desplega-ai/desplega.ai-action/actions/workflows/codeql-analysis.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

This GitHub Action integrates with desplega.ai to run test suites and receive
real-time results through server-sent events (SSE).

## Usage

```yaml
steps:
  - name: Run desplega.ai tests
    uses: desplega-ai/desplega.ai-action@v0.4.1
    with:
      apiKey: ${{ secrets.DESPLEGA_API_KEY }}
      suiteIds: 'suite-id-1'
      failFast: 'true'
      block: 'false'
      maxRetries: '3' # Enable retries with exponential backoff
```

> **Tip:** You can use `@main` to always get the latest version, or pin to a
> specific tag (e.g. `@v0.4.1`) for stability. Check the
> [releases page](https://github.com/desplega-ai/desplega.ai-action/tags) for
> available versions.

## Inputs

| Input        | Description                                                     | Required | Default Value                                                |
| ------------ | --------------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| `apiKey`     | API key for authentication                                      | Yes      | -                                                            |
| `originUrl`  | Base URL for the API                                            | No       | `https://api.desplega.ai`                                    |
| `suiteIds`   | List of suite IDs to run (comma-separated)                      | No       | -                                                            |
| `failFast`   | Whether to stop on first failure                                | No       | false                                                        |
| `block`      | Whether to block execution                                      | No       | false                                                        |
| `maxRetries` | Maximum number of retries for trigger call (0 disables retries) | No       | 0                                                            |
| `timeout`    | Maximum time in seconds to wait for the test suite to complete  | No       | 600                                                          |
| `vars`       | Variable overrides as `key=value` pairs (one per line)          | No       | -                                                            |

## Outputs

| Output   | Description                                    |
| -------- | ---------------------------------------------- |
| `runId`  | The ID of the run                              |
| `status` | The final status of the run (passed or failed) |

## How It Works

1. The action calls the desplega.ai API to trigger a test run
2. It connects to an SSE endpoint to receive real-time updates on the test
   progress
3. All events are logged to the GitHub Actions console
4. The action completes when the test run finishes (passed or failed)
5. If the test run fails, the GitHub Action will also fail

## Error Handling

- If the API call to trigger the test fails, the action will fail with an error
  message
- If the SSE connection fails, the action will fail with an error message

## Retry Functionality

The action supports automatic retry with exponential backoff for the trigger API
call when transient errors occur:

- **When enabled**: Set `maxRetries` to a value greater than 0 (maximum
  recommended: 3)
- **Retry conditions**: Only retries on 5xx server errors and network failures,
  not 4xx client errors
- **Backoff strategy**: Uses exponential backoff with delays of 1s, 2s, 4s for
  retries 1, 2, 3
- **Default behavior**: Retries are disabled by default (`maxRetries: 0`)

This helps improve reliability when dealing with temporary service
unavailability or network issues.

## Variable Overrides

Use the `vars` input to override test variables at trigger time. This is useful
for passing dynamic values like preview URLs or secrets into your test suites.

Each variable is a `key=value` pair, one per line. Values can contain `=` signs.

```yaml
steps:
  - name: Run desplega.ai tests
    uses: desplega-ai/desplega.ai-action@v0.4.1
    with:
      apiKey: ${{ secrets.DESPLEGA_API_KEY }}
      suiteIds: 'suite-id-1'
      vars: |
        base_url=https://preview-${{ github.event.number }}.example.com
        login_password=${{ secrets.TEST_PASSWORD }}
```

A common pattern is overriding `base_url` to point tests at a preview deployment:

```yaml
steps:
  - name: Deploy preview
    id: deploy
    run: echo "url=https://pr-${{ github.event.number }}.staging.example.com" >> "$GITHUB_OUTPUT"

  - name: Run E2E tests against preview
    uses: desplega-ai/desplega.ai-action@v0.4.1
    with:
      apiKey: ${{ secrets.DESPLEGA_API_KEY }}
      suiteIds: 'suite-id-1'
      vars: |
        base_url=${{ steps.deploy.outputs.url }}
```

## License

MIT License
