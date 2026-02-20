import * as core from '@actions/core'

/**
 * Parse a comma-separated string into an array of strings
 * @param input The input string
 * @returns Array of strings
 */
function parseStringArray(input: string | undefined): string[] | undefined {
  if (!input) return undefined
  return input
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * Parse a string boolean to a boolean
 * @param input The input string
 * @returns Boolean value
 */
function parseBoolean(input: string): boolean {
  return input.toLowerCase() === 'true'
}

/**
 * Parse a multiline string of key=value pairs into an array of variable objects
 * @param input Multiline string of key=value pairs
 * @returns Array of {key, value, type: "custom"} objects, or undefined if empty
 */
export function parseVars(
  input: string
): { key: string; value: string; type: string }[] | undefined {
  if (!input) return undefined

  const vars = input
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes('='))
    .map((line) => {
      const eqIndex = line.indexOf('=')
      return {
        key: line.substring(0, eqIndex),
        value: line.substring(eqIndex + 1),
        type: 'custom'
      }
    })

  return vars.length > 0 ? vars : undefined
}

/**
 * Parse a string number to a number
 * @param input The input string
 * @returns Number value
 */
function parseNumber(input: string): number {
  const num = parseInt(input, 10)
  return isNaN(num) ? 0 : num
}

/**
 * Wait for a specified number of milliseconds
 * @param ms Milliseconds to wait
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retry a function with exponential backoff
 * @param fn Function to retry
 * @param maxRetries Maximum number of retries (0 means no retries)
 * @param retryableErrorCheck Function to check if error should trigger retry
 * @returns Promise that resolves with the function result
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  retryableErrorCheck: (error: unknown) => boolean
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      // Don't retry if this is the last attempt or error is not retryable
      if (attempt === maxRetries || !retryableErrorCheck(error)) {
        throw error
      }

      // Calculate delay: 1s, 2s, 4s for attempts 1, 2, 3
      const delay = Math.pow(2, attempt) * 1000
      core.info(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`)
      await sleep(delay)
    }
  }

  throw lastError
}

const IDLE_TIMEOUT_MS = 60_000 // 60 seconds with no SSE events
const POLL_INTERVAL_MS = 10_000 // 10 seconds between polling attempts

type RunResult =
  | { outcome: 'completed'; status: string }
  | { outcome: 'idle_timeout' }
  | { outcome: 'overall_timeout' }
  | { outcome: 'error'; message: string }

/**
 * Connect to SSE endpoint for real-time event streaming.
 * Returns a result indicating the outcome instead of calling core.setFailed directly.
 */
async function connectToSSE(
  url: string,
  headers: Record<string, string>,
  timeoutSeconds: number
): Promise<RunResult> {
  const abortController = new AbortController()
  let overallTimedOut = false
  let idleTimedOut = false

  const overallTimeoutId = setTimeout(() => {
    overallTimedOut = true
    abortController.abort()
  }, timeoutSeconds * 1000)

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: abortController.signal
    })

    core.info(`SSE connection established (HTTP ${response.status})`)

    if (!response.ok || !response.body) {
      return {
        outcome: 'error',
        message: `Failed to connect to SSE endpoint: ${response.status}`
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // Idle timeout — resets on each received chunk
    let idleTimeoutId: ReturnType<typeof setTimeout> | undefined

    const resetIdleTimeout = (): void => {
      if (idleTimeoutId) clearTimeout(idleTimeoutId)
      idleTimeoutId = setTimeout(() => {
        idleTimedOut = true
        core.warning(
          `No SSE events received for ${IDLE_TIMEOUT_MS / 1000}s, aborting SSE connection`
        )
        abortController.abort()
      }, IDLE_TIMEOUT_MS)
    }

    resetIdleTimeout()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        resetIdleTimeout()

        buffer += decoder.decode(value, { stream: true })

        // Process complete events in the buffer
        const events = buffer.split('\n\n')
        buffer = events.pop() || '' // last element may be incomplete

        for (const event of events) {
          if (!event.trim()) continue

          // Skip SSE comments (heartbeats)
          const lines = event.split('\n').filter((l) => !l.startsWith(':'))
          if (lines.length === 0) continue

          // Extract the event data
          const eventData = lines
            .find((l) => l.startsWith('data:'))
            ?.substring(5)
            .trim()

          const eventType = lines
            .find((l) => l.startsWith('event:'))
            ?.substring(6)
            .trim()

          core.debug(`Event type: ${eventType}`)
          core.debug(`Event data: ${eventData}`)

          if (eventData) {
            try {
              const event = JSON.parse(eventData)
              core.info(`Event received: ${JSON.stringify(event)}`)

              const ts = event.ts ? new Date(event.ts).toISOString() : '-'
              const status = event.status
              const elapsed = event.elapsed
                ? `(${event.elapsed} seconds)`
                : '-'

              core.info(`${eventType} at ${ts}: ${status} ${elapsed}`)

              if (eventType !== 'test_suite_run.event') {
                continue
              }

              // Check if the run has completed
              if (!['pending', 'running'].includes(status)) {
                return { outcome: 'completed', status }
              }
            } catch {
              core.warning(`Failed to parse event data: ${eventData}`)
            }
          }
        }
      }

      // Stream ended without a terminal status
      return { outcome: 'error', message: 'SSE stream ended unexpectedly' }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        if (overallTimedOut) {
          return { outcome: 'overall_timeout' }
        }
        if (idleTimedOut) {
          return { outcome: 'idle_timeout' }
        }
        // Aborted for other reasons
        return { outcome: 'error', message: 'SSE connection aborted' }
      }
      throw e
    } finally {
      if (idleTimeoutId) clearTimeout(idleTimeoutId)
      reader.releaseLock()
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (overallTimedOut) return { outcome: 'overall_timeout' }
      if (idleTimedOut) return { outcome: 'idle_timeout' }
    }
    return {
      outcome: 'error',
      message:
        error instanceof Error ? error.message : 'Unknown SSE connection error'
    }
  } finally {
    clearTimeout(overallTimeoutId)
    abortController.abort()
  }
}

/**
 * Poll the run status via REST API as a fallback when SSE is unavailable.
 */
async function pollRunStatus(
  originUrl: string,
  runId: string,
  headers: Record<string, string>,
  timeoutSeconds: number
): Promise<RunResult> {
  const deadline = Date.now() + timeoutSeconds * 1000

  core.info('Switching to polling mode for run status updates')

  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `${originUrl}/external/actions/run/${runId}`,
        { method: 'GET', headers }
      )

      if (!response.ok) {
        core.warning(`Polling request failed with status ${response.status}`)
        await sleep(POLL_INTERVAL_MS)
        continue
      }

      const data = (await response.json()) as Record<string, unknown>
      const status = data.status as string

      core.info(`Polling run status: ${status}`)

      if (!['pending', 'running'].includes(status)) {
        return { outcome: 'completed', status }
      }
    } catch (error) {
      core.warning(
        `Polling error: ${error instanceof Error ? error.message : 'unknown'}`
      )
    }

    await sleep(POLL_INTERVAL_MS)
  }

  return { outcome: 'overall_timeout' }
}

/**
 * The main function for the action.
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // Get inputs
    const apiKey = core.getInput('apiKey', { required: true })
    const originUrl = core.getInput('originUrl')
    const suiteIdsInput = core.getInput('suiteIds')
    const failFast = parseBoolean(core.getInput('failFast'))
    const block = parseBoolean(core.getInput('block'))
    const maxRetries = parseNumber(core.getInput('maxRetries'))
    const timeout = parseNumber(core.getInput('timeout')) || 600
    const varsInput = core.getInput('vars')

    // Parse suiteIds if provided
    const suiteIds = parseStringArray(suiteIdsInput)

    // Parse vars if provided
    const vars = parseVars(varsInput)

    // Debug logs
    core.debug('Inputs:')
    core.debug(`- originUrl: ${originUrl}`)
    core.debug(`- suiteIds: ${suiteIds ? suiteIds.join(', ') : 'not provided'}`)
    core.debug(`- failFast: ${failFast}`)
    core.debug(`- block: ${block}`)
    core.debug(`- maxRetries: ${maxRetries}`)
    core.debug(`- timeout: ${timeout}`)
    core.debug(`- vars: ${vars ? JSON.stringify(vars) : 'not provided'}`)

    // Prepare request body
    const body: Record<string, unknown> = {}
    if (suiteIds) body.suite_ids = suiteIds
    body.fail_fast = failFast
    if (vars) body.vars = vars

    try {
      const versionUrl = `${originUrl}/version`

      const fetchVersion = async (): Promise<string> => {
        const resp = await fetch(versionUrl)
        if (!resp.ok) {
          throw new Error(`Version endpoint returned ${resp.status}`)
        }
        const data = (await resp.json()) as Record<string, string>
        return data?.version ?? 'unknown'
      }

      const version = await retryWithBackoff(
        fetchVersion,
        3, // 3 retries (exponential backoff: 1s, 2s, 4s, 8s = ~15s max)
        () => true // retry on any error
      )

      core.info(`Using API version: ${version}`)
      core.setOutput('version', version)
    } catch (error) {
      core.warning(
        `Failed to fetch version after retries: ${error instanceof Error ? error.message : 'unknown error'}`
      )
    }

    // Trigger the action
    core.info('Triggering test suite execution...')
    core.debug(`Request body: ${JSON.stringify(body)}`)

    const triggerUrl = `${originUrl}/external/actions/trigger`

    // Function to check if an error should trigger a retry
    const shouldRetry = (error: unknown): boolean => {
      if (error instanceof Error) {
        // Check if it's a fetch error (network issues)
        if (error.message.includes('fetch')) {
          return true
        }

        // Check if error message contains HTTP status indicating server error (5xx)
        const statusMatch = error.message.match(
          /Failed to trigger action: (\d+)/
        )
        if (statusMatch) {
          const status = parseInt(statusMatch[1], 10)
          return status >= 500 && status < 600
        }
      }
      return false
    }

    // Trigger function that can be retried
    const triggerAction = async (): Promise<{ run_id: string }> => {
      const triggerResponse = await fetch(triggerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey
        },
        body: JSON.stringify(body)
      })

      if (!triggerResponse.ok) {
        const errorText = await triggerResponse.text()
        throw new Error(
          `Failed to trigger action: ${triggerResponse.status} ${errorText}`
        )
      }

      return (await triggerResponse.json()) as { run_id: string }
    }

    // Execute with retry logic if maxRetries > 0
    const triggerData =
      maxRetries > 0
        ? await retryWithBackoff(triggerAction, maxRetries, shouldRetry)
        : await triggerAction()
    const runId = triggerData.run_id

    if (!runId) {
      throw new Error('No run ID received from the trigger endpoint')
    }

    core.info(`Run ID: ${runId}`)
    core.setOutput('runId', runId)

    // Non-blocking mode: exit immediately after triggering
    if (!block) {
      core.info(`Run triggered (non-blocking mode). Run ID: ${runId}`)
      core.setOutput('status', 'running')
      return
    }

    // Connect to SSE for real-time events
    const sseUrl = `${originUrl}/external/actions/run/${runId}/events`
    core.info(`Connecting to SSE endpoint: ${sseUrl}`)

    const authHeaders = { 'X-Api-Key': apiKey }
    let result = await connectToSSE(sseUrl, authHeaders, timeout)

    // If SSE produced no events (idle timeout), fall back to polling
    if (result.outcome === 'idle_timeout') {
      core.info(
        'SSE connection idle — falling back to REST polling for run status'
      )
      const elapsedSeconds = Math.round(IDLE_TIMEOUT_MS / 1000)
      const remainingTimeout = Math.max(timeout - elapsedSeconds, 30)
      result = await pollRunStatus(
        originUrl,
        runId,
        authHeaders,
        remainingTimeout
      )
    }

    // Handle the final result
    switch (result.outcome) {
      case 'completed':
        core.setOutput('status', result.status)
        if (!['passed', 'flaky'].includes(result.status)) {
          core.setFailed(
            `Test suite execution failed with status: ${result.status}`
          )
        } else {
          core.info('Test suite execution completed')
        }
        break
      case 'overall_timeout':
        core.setFailed(
          `Timed out after ${timeout}s waiting for test suite completion`
        )
        break
      case 'error':
        core.setFailed(`SSE connection error: ${result.message}`)
        break
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
    else core.setFailed('An unknown error occurred')
  }
}
