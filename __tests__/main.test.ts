/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * To mock dependencies in ESM, you can create fixtures that export mock
 * functions and objects. For example, the core module is mocked in this test,
 * so that the actual '@actions/core' module is not imported.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

// Utility to create a minimal mock Response
function createMockResponse(options: {
  ok: boolean
  status?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json?: () => Promise<any>
  text?: () => Promise<string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any
}): Response {
  const { ok, status = 200, json, text, body } = options

  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: new Headers(),
    body,
    bodyUsed: false,
    type: 'basic',
    url: '',
    redirected: false,
    json: json || (() => Promise.resolve({})),
    text: text || (() => Promise.resolve('')),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob([])),
    formData: () => Promise.resolve(new FormData()),
    clone: () => createMockResponse(options)
  } as unknown as Response
}

// Global fetch mock
const fetchMock = jest.fn<typeof fetch>()
global.fetch = fetchMock

// Mock for ReadableStream and TextDecoder
class MockReadableStreamDefaultReader {
  private events: Array<{ done: boolean; value: Uint8Array }> = []
  private currentEventIndex = 0

  setEvents(events: Array<{ done: boolean; value: Uint8Array }>): void {
    this.events = events
    this.currentEventIndex = 0
  }

  async read(): Promise<{ done: boolean; value: Uint8Array }> {
    if (this.currentEventIndex >= this.events.length) {
      return { done: true, value: new Uint8Array() }
    }
    return this.events[this.currentEventIndex++]
  }

  releaseLock(): void {
    // no-op for mock
  }
}

const mockReader = new MockReadableStreamDefaultReader()

const mockBody = {
  getReader: () => mockReader
}

// Mocks should be declared before the module being tested is imported.
jest.unstable_mockModule('@actions/core', () => core)

// The module being tested should be imported dynamically. This ensures that the
// mocks are used in place of any actual dependencies.
const { run, parseVars } = await import('../src/main.js')

describe('main.ts', () => {
  const mockApiKey = 'test-api-key'
  const mockOriginUrl = 'https://test-origin.com'
  const mockRunId = 'test-run-id'

  beforeEach(() => {
    // Reset all mocks
    jest.resetAllMocks()
    jest.clearAllMocks()

    // Set up input mocks — block: 'true' so tests exercise SSE path
    core.getInput.mockImplementation((name) => {
      if (name === 'apiKey') return mockApiKey
      if (name === 'originUrl') return mockOriginUrl
      if (name === 'suiteIds') return 'suite1,suite2'
      if (name === 'failFast') return 'false'
      if (name === 'block') return 'true'
      return ''
    })

    // Set up fetch mock for successful response
    fetchMock.mockImplementation(async (url) => {
      if (url === `${mockOriginUrl}/external/actions/trigger`) {
        return createMockResponse({
          ok: true,
          json: async () => ({ run_id: mockRunId })
        })
      } else if (url === `${mockOriginUrl}/version`) {
        return createMockResponse({
          ok: true,
          json: async () => ({ version: '1337' })
        })
      } else if (
        url === `${mockOriginUrl}/external/actions/run/${mockRunId}/events`
      ) {
        // Set up events for the reader
        const encoder = new TextEncoder()
        mockReader.setEvents([
          {
            done: false,
            value: encoder.encode(
              'event: test_suite_run.event\ndata: {"text": "All tests completed", "status": "passed"}\n\n'
            )
          },
          { done: true, value: new Uint8Array() }
        ])

        return createMockResponse({
          ok: true,
          body: mockBody
        })
      }

      return createMockResponse({
        ok: false,
        status: 404,
        text: async () => 'Not found'
      })
    })
  })

  it('Should trigger a test run and process SSE events', async () => {
    await run()

    expect(fetchMock).toHaveBeenCalledWith(`${mockOriginUrl}/version`)
    expect(core.setOutput).toHaveBeenCalledWith('version', '1337')

    // Verify API call to trigger endpoint
    expect(fetchMock).toHaveBeenCalledWith(
      `${mockOriginUrl}/external/actions/trigger`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Api-Key': mockApiKey
        }),
        body: expect.stringContaining('suite_ids')
      })
    )

    // Verify SSE connection was made
    expect(fetchMock).toHaveBeenCalledWith(
      `${mockOriginUrl}/external/actions/run/${mockRunId}/events`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'X-Api-Key': mockApiKey
        })
      })
    )

    // Verify outputs were set
    expect(core.setOutput).toHaveBeenCalledWith('runId', mockRunId)
    expect(core.setOutput).toHaveBeenCalledWith('status', 'passed')
  })

  it('Should handle API trigger failure', async () => {
    // Mock version success, trigger failure
    fetchMock.mockReset().mockImplementation(async (url) => {
      if (url === `${mockOriginUrl}/version`) {
        return createMockResponse({
          ok: true,
          json: async () => ({ version: '1337' })
        })
      }
      // Trigger endpoint fails
      return createMockResponse({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized'
      })
    })

    await run()

    // Verify error handling
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Failed to trigger action: 401')
    )
  })

  it('Should handle SSE connection failure', async () => {
    // First call succeeds (trigger), second fails (SSE)
    fetchMock
      .mockReset()
      .mockImplementationOnce(async () => {
        return createMockResponse({
          ok: true,
          json: async () => ({ version: '1337' })
        })
      })
      .mockImplementationOnce(async () => {
        return createMockResponse({
          ok: true,
          json: async () => ({ run_id: mockRunId })
        })
      })
      .mockImplementationOnce(async () => {
        return createMockResponse({
          ok: false,
          status: 500,
          text: async () => 'Server error'
        })
      })

    await run()

    // Verify error handling for SSE connection
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('SSE connection error')
    )
  })

  it('Should exit immediately in non-blocking mode (block: false)', async () => {
    core.getInput.mockImplementation((name) => {
      if (name === 'apiKey') return mockApiKey
      if (name === 'originUrl') return mockOriginUrl
      if (name === 'suiteIds') return 'suite1'
      if (name === 'failFast') return 'false'
      if (name === 'block') return 'false'
      return ''
    })

    await run()

    // Should trigger but NOT connect to SSE
    expect(fetchMock).toHaveBeenCalledWith(
      `${mockOriginUrl}/external/actions/trigger`,
      expect.any(Object)
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      `${mockOriginUrl}/external/actions/run/${mockRunId}/events`,
      expect.any(Object)
    )

    // Should set runId and status='running'
    expect(core.setOutput).toHaveBeenCalledWith('runId', mockRunId)
    expect(core.setOutput).toHaveBeenCalledWith('status', 'running')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  describe('Bad statuses', () => {
    it.each(['failed', 'failed_pending', 'error', 'timed_out', 'cancelled'])(
      '[Un-happy] Should handle test run with status: %s',
      async (status) => {
        fetchMock
          .mockReset()
          .mockImplementationOnce(async () => {
            return createMockResponse({
              ok: true,
              json: async () => ({ version: '1337' })
            })
          })
          .mockImplementationOnce(async () => {
            return createMockResponse({
              ok: true,
              json: async () => ({ run_id: mockRunId })
            })
          })
          .mockImplementationOnce(async () => {
            // Set up events for the reader with a failed status
            const encoder = new TextEncoder()
            mockReader.setEvents([
              {
                done: false,
                value: encoder.encode(
                  'event: test_suite_run.event\ndata: {"text": "Test started", "status": "running"}\n\n'
                )
              },
              {
                done: false,
                value: encoder.encode(
                  `event: test_suite_run.event\ndata: {"text": "Test failed", "status": "${status}"}\n\n`
                )
              },
              { done: true, value: new Uint8Array() }
            ])

            return createMockResponse({
              ok: true,
              body: mockBody
            })
          })

        await run()

        // Verify the failed status is set
        expect(core.setOutput).toHaveBeenCalledWith('status', status)
        expect(core.setFailed).toHaveBeenCalledWith(
          `Test suite execution failed with status: ${status}`
        )
      }
    )
  })

  describe('OK statuses', () => {
    it.each(['passed', 'flaky'])(
      '[Happy] Should handle test run with OK status: %s',
      async (status) => {
        fetchMock
          .mockReset()
          .mockImplementationOnce(async () => {
            return createMockResponse({
              ok: true,
              json: async () => ({ version: '1337' })
            })
          })
          .mockImplementationOnce(async () => {
            return createMockResponse({
              ok: true,
              json: async () => ({ run_id: mockRunId })
            })
          })
          .mockImplementationOnce(async () => {
            // Set up events for the reader with a failed status
            const encoder = new TextEncoder()
            mockReader.setEvents([
              {
                done: false,
                value: encoder.encode(
                  'event: test_suite_run.event\ndata: {"text": "Test started", "status": "running"}\n\n'
                )
              },
              {
                done: false,
                value: encoder.encode(
                  `event: test_suite_run.event\ndata: {"text": "Test OK!", "status": "${status}"}\n\n`
                )
              },
              { done: true, value: new Uint8Array() }
            ])

            return createMockResponse({
              ok: true,
              body: mockBody
            })
          })

        await run()

        expect(core.setOutput).toHaveBeenCalledWith('status', status)
        expect(core.setFailed).not.toHaveBeenCalled()
      }
    )
  })

  describe('Pending statuses', () => {
    it.each(['running', 'pending'])(
      '[Happy] Should handle test run with pending status: %s',
      async (status) => {
        fetchMock
          .mockReset()
          .mockImplementationOnce(async () => {
            return createMockResponse({
              ok: true,
              json: async () => ({ version: '1337' })
            })
          })
          .mockImplementationOnce(async () => {
            return createMockResponse({
              ok: true,
              json: async () => ({ run_id: mockRunId })
            })
          })
          .mockImplementationOnce(async () => {
            // Pending/running event followed by a terminal "passed" event
            const encoder = new TextEncoder()
            mockReader.setEvents([
              {
                done: false,
                value: encoder.encode(
                  `event: test_suite_run.event\ndata: {"text": "blu blu", "status": "${status}"}\n\n`
                )
              },
              {
                done: false,
                value: encoder.encode(
                  'event: test_suite_run.event\ndata: {"text": "done", "status": "passed"}\n\n'
                )
              },
              { done: true, value: new Uint8Array() }
            ])

            return createMockResponse({
              ok: true,
              body: mockBody
            })
          })

        await run()

        // The pending/running event should NOT trigger completion
        // Only the terminal "passed" event should set the final status
        expect(core.setOutput).toHaveBeenCalledWith('status', 'passed')
        expect(core.setFailed).not.toHaveBeenCalled()
      }
    )
  })

  describe('Retry functionality', () => {
    beforeEach(() => {
      // Reset all mocks for retry tests
      jest.resetAllMocks()

      // Set up input mocks with retries enabled
      core.getInput.mockImplementation((name) => {
        if (name === 'apiKey') return mockApiKey
        if (name === 'originUrl') return mockOriginUrl
        if (name === 'suiteIds') return 'suite1,suite2'
        if (name === 'failFast') return 'false'
        if (name === 'block') return 'true'
        if (name === 'maxRetries') return '2' // Enable retries
        return ''
      })
    })

    it('Should retry on 5xx server errors and eventually succeed', async () => {
      let attemptCount = 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchMock.mockImplementation(async (url: any) => {
        if (url === `${mockOriginUrl}/version`) {
          return createMockResponse({
            ok: true,
            json: async () => ({ version: '1337' })
          })
        } else if (url === `${mockOriginUrl}/external/actions/trigger`) {
          attemptCount++
          if (attemptCount < 3) {
            // First 2 attempts fail with 503
            return createMockResponse({
              ok: false,
              status: 503,
              text: async () => 'Service Unavailable'
            })
          } else {
            // Third attempt succeeds
            return createMockResponse({
              ok: true,
              json: async () => ({ run_id: mockRunId })
            })
          }
        } else if (
          url === `${mockOriginUrl}/external/actions/run/${mockRunId}/events`
        ) {
          const encoder = new TextEncoder()
          mockReader.setEvents([
            {
              done: false,
              value: encoder.encode(
                'event: test_suite_run.event\ndata: {"text": "All tests completed", "status": "passed"}\n\n'
              )
            },
            { done: true, value: new Uint8Array() }
          ])

          return createMockResponse({
            ok: true,
            body: mockBody
          })
        }

        return createMockResponse({
          ok: false,
          status: 404,
          text: async () => 'Not found'
        })
      })

      await run()

      // Verify trigger was called 3 times (1 initial + 2 retries)
      expect(fetchMock).toHaveBeenCalledWith(
        `${mockOriginUrl}/external/actions/trigger`,
        expect.any(Object)
      )
      expect(fetchMock).toHaveBeenCalledTimes(5) // version + 3 trigger attempts + SSE
      expect(core.setOutput).toHaveBeenCalledWith('runId', mockRunId)
    })

    it('Should not retry on 4xx client errors', async () => {
      fetchMock.mockImplementation(async (url) => {
        if (url === `${mockOriginUrl}/version`) {
          return createMockResponse({
            ok: true,
            json: async () => ({ version: '1337' })
          })
        } else if (url === `${mockOriginUrl}/external/actions/trigger`) {
          return createMockResponse({
            ok: false,
            status: 401,
            text: async () => 'Unauthorized'
          })
        }

        return createMockResponse({
          ok: false,
          status: 404,
          text: async () => 'Not found'
        })
      })

      await run()

      // Verify trigger was called only once (no retries for 4xx errors)
      expect(fetchMock).toHaveBeenCalledWith(
        `${mockOriginUrl}/external/actions/trigger`,
        expect.any(Object)
      )
      expect(fetchMock).toHaveBeenCalledTimes(2) // version + 1 trigger attempt (no retries)
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Failed to trigger action: 401')
      )
    })

    it('Should exhaust all retries and fail after max attempts', async () => {
      fetchMock.mockImplementation(async (url) => {
        if (url === `${mockOriginUrl}/version`) {
          return createMockResponse({
            ok: true,
            json: async () => ({ version: '1337' })
          })
        } else if (url === `${mockOriginUrl}/external/actions/trigger`) {
          // Always fail with 503
          return createMockResponse({
            ok: false,
            status: 503,
            text: async () => 'Service Unavailable'
          })
        }

        return createMockResponse({
          ok: false,
          status: 404,
          text: async () => 'Not found'
        })
      })

      await run()

      // Verify trigger was called 3 times (1 initial + 2 retries)
      expect(fetchMock).toHaveBeenCalledWith(
        `${mockOriginUrl}/external/actions/trigger`,
        expect.any(Object)
      )
      expect(fetchMock).toHaveBeenCalledTimes(4) // version + 3 trigger attempts
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Failed to trigger action: 503')
      )
    })

    it('Should not retry when maxRetries is 0 (default)', async () => {
      // Reset mocks to default (no retries, non-blocking)
      core.getInput.mockImplementation((name) => {
        if (name === 'apiKey') return mockApiKey
        if (name === 'originUrl') return mockOriginUrl
        if (name === 'suiteIds') return 'suite1,suite2'
        if (name === 'failFast') return 'false'
        if (name === 'block') return 'false'
        if (name === 'maxRetries') return '0' // Disable retries
        return ''
      })

      fetchMock.mockImplementation(async (url) => {
        if (url === `${mockOriginUrl}/version`) {
          return createMockResponse({
            ok: true,
            json: async () => ({ version: '1337' })
          })
        } else if (url === `${mockOriginUrl}/external/actions/trigger`) {
          return createMockResponse({
            ok: false,
            status: 503,
            text: async () => 'Service Unavailable'
          })
        }

        return createMockResponse({
          ok: false,
          status: 404,
          text: async () => 'Not found'
        })
      })

      await run()

      // Verify trigger was called only once (no retries)
      expect(fetchMock).toHaveBeenCalledWith(
        `${mockOriginUrl}/external/actions/trigger`,
        expect.any(Object)
      )
      expect(fetchMock).toHaveBeenCalledTimes(2) // version + 1 trigger attempt
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Failed to trigger action: 503')
      )
    })
  })

  describe('Timeout', () => {
    it('Should fail with timeout message when SSE reader hangs', async () => {
      // Use fake timers so we can advance the timeout instantly
      jest.useFakeTimers()

      // Set timeout to 1 second
      core.getInput.mockImplementation((name) => {
        if (name === 'apiKey') return mockApiKey
        if (name === 'originUrl') return mockOriginUrl
        if (name === 'suiteIds') return 'suite1,suite2'
        if (name === 'failFast') return 'false'
        if (name === 'block') return 'true'
        if (name === 'timeout') return '1'
        return ''
      })

      // Track the abort signal so we can simulate AbortError when aborted
      let capturedSignal: AbortSignal | undefined

      fetchMock.mockImplementation(async (url, init) => {
        if (url === `${mockOriginUrl}/version`) {
          return createMockResponse({
            ok: true,
            json: async () => ({ version: '1337' })
          })
        } else if (url === `${mockOriginUrl}/external/actions/trigger`) {
          return createMockResponse({
            ok: true,
            json: async () => ({ run_id: mockRunId })
          })
        } else if (
          url === `${mockOriginUrl}/external/actions/run/${mockRunId}/events`
        ) {
          // Capture the abort signal from the request
          capturedSignal = (init as RequestInit)?.signal ?? undefined

          // Create a reader that blocks until aborted
          const hangingReader = {
            read: () =>
              new Promise<{ done: boolean; value: Uint8Array }>(
                (resolve, reject) => {
                  if (capturedSignal?.aborted) {
                    const err = new Error('The operation was aborted')
                    err.name = 'AbortError'
                    reject(err)
                    return
                  }
                  // Listen for abort to reject the promise
                  capturedSignal?.addEventListener('abort', () => {
                    const err = new Error('The operation was aborted')
                    err.name = 'AbortError'
                    reject(err)
                  })
                  // Never resolves on its own — simulates a hanging reader
                }
              ),
            releaseLock: () => {}
          }

          return createMockResponse({
            ok: true,
            body: { getReader: () => hangingReader }
          })
        }

        return createMockResponse({
          ok: false,
          status: 404,
          text: async () => 'Not found'
        })
      })

      // Start run() — it will block on the hanging reader
      const runPromise = run()

      // Advance timers past the 1-second timeout
      await jest.advanceTimersByTimeAsync(1500)

      await runPromise

      expect(core.setFailed).toHaveBeenCalledWith(
        'Timed out after 1s waiting for test suite completion'
      )

      jest.useRealTimers()
    })
  })

  describe('parseVars', () => {
    it('Should parse basic key=value pairs', () => {
      const result = parseVars('base_url=https://staging.example.com\nlogin_password=s3cret')
      expect(result).toEqual([
        { key: 'base_url', value: 'https://staging.example.com', type: 'custom' },
        { key: 'login_password', value: 's3cret', type: 'custom' }
      ])
    })

    it('Should handle values containing = signs', () => {
      const result = parseVars('token=abc=def=ghi')
      expect(result).toEqual([
        { key: 'token', value: 'abc=def=ghi', type: 'custom' }
      ])
    })

    it('Should skip empty lines and whitespace-only lines', () => {
      const result = parseVars('key1=val1\n\n  \nkey2=val2')
      expect(result).toEqual([
        { key: 'key1', value: 'val1', type: 'custom' },
        { key: 'key2', value: 'val2', type: 'custom' }
      ])
    })

    it('Should skip lines without =', () => {
      const result = parseVars('key1=val1\nno_equals_here\nkey2=val2')
      expect(result).toEqual([
        { key: 'key1', value: 'val1', type: 'custom' },
        { key: 'key2', value: 'val2', type: 'custom' }
      ])
    })

    it('Should trim whitespace around lines', () => {
      const result = parseVars('  key1=val1  \n  key2=val2  ')
      expect(result).toEqual([
        { key: 'key1', value: 'val1', type: 'custom' },
        { key: 'key2', value: 'val2', type: 'custom' }
      ])
    })

    it('Should return undefined for empty string', () => {
      expect(parseVars('')).toBeUndefined()
    })

    it('Should return undefined for whitespace-only input', () => {
      expect(parseVars('  \n  \n  ')).toBeUndefined()
    })

    it('Should handle value with empty string', () => {
      const result = parseVars('key=')
      expect(result).toEqual([
        { key: 'key', value: '', type: 'custom' }
      ])
    })
  })

  describe('vars in trigger request', () => {
    it('Should include vars in trigger body when provided', async () => {
      core.getInput.mockImplementation((name) => {
        if (name === 'apiKey') return mockApiKey
        if (name === 'originUrl') return mockOriginUrl
        if (name === 'suiteIds') return 'suite1'
        if (name === 'failFast') return 'false'
        if (name === 'block') return 'false'
        if (name === 'vars') return 'base_url=https://preview.example.com\nlogin_password=test123'
        return ''
      })

      await run()

      // Find the trigger call and verify vars are in the body
      const triggerCall = fetchMock.mock.calls.find(
        (call) => call[0] === `${mockOriginUrl}/external/actions/trigger`
      )
      expect(triggerCall).toBeDefined()

      const body = JSON.parse(triggerCall![1]!.body as string)
      expect(body.vars).toEqual([
        { key: 'base_url', value: 'https://preview.example.com', type: 'custom' },
        { key: 'login_password', value: 'test123', type: 'custom' }
      ])
    })

    it('Should omit vars from trigger body when input is empty', async () => {
      core.getInput.mockImplementation((name) => {
        if (name === 'apiKey') return mockApiKey
        if (name === 'originUrl') return mockOriginUrl
        if (name === 'suiteIds') return 'suite1'
        if (name === 'failFast') return 'false'
        if (name === 'block') return 'false'
        if (name === 'vars') return ''
        return ''
      })

      await run()

      const triggerCall = fetchMock.mock.calls.find(
        (call) => call[0] === `${mockOriginUrl}/external/actions/trigger`
      )
      expect(triggerCall).toBeDefined()

      const body = JSON.parse(triggerCall![1]!.body as string)
      expect(body.vars).toBeUndefined()
    })
  })

  describe('SSE buffer partial chunk parsing', () => {
    it('Should correctly parse events split across multiple chunks', async () => {
      core.getInput.mockImplementation((name) => {
        if (name === 'apiKey') return mockApiKey
        if (name === 'originUrl') return mockOriginUrl
        if (name === 'suiteIds') return 'suite1,suite2'
        if (name === 'failFast') return 'false'
        if (name === 'block') return 'true'
        return ''
      })

      fetchMock.mockImplementation(async (url) => {
        if (url === `${mockOriginUrl}/version`) {
          return createMockResponse({
            ok: true,
            json: async () => ({ version: '1337' })
          })
        } else if (url === `${mockOriginUrl}/external/actions/trigger`) {
          return createMockResponse({
            ok: true,
            json: async () => ({ run_id: mockRunId })
          })
        } else if (
          url === `${mockOriginUrl}/external/actions/run/${mockRunId}/events`
        ) {
          const encoder = new TextEncoder()
          // Split the event mid-message across two chunks
          const splitReader = new MockReadableStreamDefaultReader()
          splitReader.setEvents([
            {
              done: false,
              value: encoder.encode(
                'event: test_suite_run.event\ndata: {"status":'
              )
            },
            {
              done: false,
              value: encoder.encode(' "passed", "elapsed": 1.5}\n\n')
            },
            { done: true, value: new Uint8Array() }
          ])

          return createMockResponse({
            ok: true,
            body: { getReader: () => splitReader }
          })
        }

        return createMockResponse({
          ok: false,
          status: 404,
          text: async () => 'Not found'
        })
      })

      await run()

      expect(core.setOutput).toHaveBeenCalledWith('status', 'passed')
      expect(core.setFailed).not.toHaveBeenCalled()
    })
  })
})
