// Test execution types
export type TestType = 'mcp' | 'ui';

export interface TestExecution {
  execution_id: string;
  test_type: TestType;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  start_time: string;
  end_time?: string;
  duration?: number;
  exit_code?: number;
  output?: string[];
}

export interface TestExecutionRequest {
  test_type: TestType;
  options?: Record<string, any>;
}

export interface TestStreamMessage {
  type: 'status' | 'output' | 'completed' | 'error' | 'cancelled';
  execution_id: string;
  data?: any;
  message?: string;
  timestamp: string;
}

export interface TestHistory {
  executions: TestExecution[];
  total_count: number;
}

export interface TestStatus {
  execution_id: string;
  status: string;
  start_time: string;
  end_time?: string;
  duration?: number;
  exit_code?: number;
}

// Dynamic API base URL that works with different hosts
const getApiBaseUrl = () => {
  const protocol = window.location.protocol;
  const host = window.location.hostname;
  const port = '8080'; // Backend API port
  return `${protocol}//${host}:${port}`;
};

const API_BASE_URL = getApiBaseUrl();

// Error class for test service errors
export class TestServiceError extends Error {
  constructor(message: string, public code: string, public statusCode?: number) {
    super(message);
    this.name = 'TestServiceError';
  }
}

// Helper function to call FastAPI endpoints directly
async function callAPI<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options
    });

    if (!response.ok) {
      throw new TestServiceError(
        `HTTP error! status: ${response.status}`, 
        'HTTP_ERROR', 
        response.status
      );
    }

    const result = await response.json();
    
    // Check if response has error field (from FastAPI error format)
    if (result.error) {
      throw new TestServiceError(
        result.error, 
        'API_ERROR',
        response.status
      );
    }

    return result as T;
  } catch (error) {
    if (error instanceof TestServiceError) {
      throw error;
    }
    
    throw new TestServiceError(
      `Failed to call API ${endpoint}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'NETWORK_ERROR',
      500
    );
  }
}

class TestService {
  private wsConnections: Map<string, WebSocket> = new Map();

  /**
   * Execute Python tests using pytest via backend API
   */
  async runMCPTests(): Promise<TestExecution> {
    const requestBody: TestExecutionRequest = {
      test_type: 'mcp',
      options: {}
    };

    const response = await callAPI<TestExecution>('/api/tests/mcp/run', {
      method: 'POST',
      body: JSON.stringify(requestBody)
    });
    return response;
  }

  /**
   * Execute React UI tests locally in the frontend
   */
  async runUITests(): Promise<TestExecution> {
    // Generate a local execution ID
    const execution_id = crypto.randomUUID();
    
    // Return immediately with execution info - actual test running happens separately
    return {
      execution_id,
      test_type: 'ui',
      status: 'pending',
      start_time: new Date().toISOString()
    };
  }

  /**
   * Run React tests locally using the Vite dev server endpoint and stream output
   */
  async runUITestsWithStreaming(
    onMessage: (message: TestStreamMessage) => void,
    onError?: (error: Error) => void,
    onComplete?: () => void
  ): Promise<string> {
    const execution_id = crypto.randomUUID();
    
    try {
      // Send initial status
      onMessage({
        type: 'status',
        execution_id,
        data: { status: 'running' },
        message: 'Starting React UI tests...',
        timestamp: new Date().toISOString()
      });

      // Call the Vite dev server endpoint to run real vitest tests
      const response = await fetch('/api/run-tests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to start tests: ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body reader available');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              // Forward the real test output with our execution_id
              onMessage({
                ...data,
                execution_id
              });
              
              if (data.type === 'completed') {
                onComplete?.();
                return execution_id;
              }
              
              if (data.type === 'error') {
                onError?.(new Error(data.message));
                return execution_id;
              }
            } catch (e) {
              console.warn('Failed to parse SSE message:', line);
            }
          }
        }
      }

      return execution_id;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      onMessage({
        type: 'error',
        execution_id,
        message: errorMessage,
        timestamp: new Date().toISOString()
      });
      onError?.(error instanceof Error ? error : new Error(errorMessage));
      return execution_id;
    }
  }

  /**
   * Get test execution status
   */
  async getTestStatus(executionId: string): Promise<TestStatus> {
    const response = await callAPI<TestStatus>(`/api/tests/status/${executionId}`);
    return response;
  }

  /**
   * Get test execution history
   */
  async getTestHistory(): Promise<TestHistory> {
    const response = await callAPI<TestHistory>('/api/tests/history');
    return response;
  }

  /**
   * Cancel a running test execution
   */
  async cancelTestExecution(executionId: string): Promise<void> {
    await callAPI<void>(`/api/tests/execution/${executionId}`, {
      method: 'DELETE',
    });
  }

  /**
   * Connect to WebSocket stream for real-time test output
   */
  connectToTestStream(
    executionId: string,
    onMessage: (message: TestStreamMessage) => void,
    onError?: (error: Event) => void,
    onClose?: (event: CloseEvent) => void
  ): () => void {
    // Clean up any existing connection
    this.disconnectFromTestStream(executionId);

    const wsUrl = API_BASE_URL.replace('http', 'ws') + `/api/tests/stream/${executionId}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`Connected to test stream: ${executionId}`);
    };

    ws.onmessage = (event) => {
      try {
        const message: TestStreamMessage = JSON.parse(event.data);
        onMessage(message);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error, event.data);
      }
    };

    ws.onerror = (error) => {
      console.error(`WebSocket error for test ${executionId}:`, error);
      if (onError) {
        onError(error);
      }
    };

    ws.onclose = (event) => {
      console.log(`WebSocket closed for test ${executionId}:`, event.code, event.reason);
      this.wsConnections.delete(executionId);
      if (onClose) {
        onClose(event);
      }
    };

    // Store the connection
    this.wsConnections.set(executionId, ws);

    // Return cleanup function
    return () => this.disconnectFromTestStream(executionId);
  }

  /**
   * Disconnect from WebSocket stream
   */
  disconnectFromTestStream(executionId: string): void {
    const ws = this.wsConnections.get(executionId);
    if (ws) {
      ws.close();
      this.wsConnections.delete(executionId);
    }
  }

  /**
   * Disconnect all WebSocket connections
   */
  disconnectAllStreams(): void {
    this.wsConnections.forEach((ws) => {
      ws.close();
    });
    this.wsConnections.clear();
  }

  /**
   * Check if a test stream is connected
   */
  isStreamConnected(executionId: string): boolean {
    const ws = this.wsConnections.get(executionId);
    return ws ? ws.readyState === WebSocket.OPEN : false;
  }
}

// Export singleton instance
export const testService = new TestService();
export default testService; 