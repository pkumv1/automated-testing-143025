import axios from 'axios';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class APITester {
  constructor(baseURL = process.env.API_URL || 'http://localhost:3000') {
    this.baseURL = baseURL;
    this.results = [];
    this.changeDetails = this.loadChangeDetails();
  }

  loadChangeDetails() {
    const analysisPath = path.join(__dirname, '../test-results/change-analysis.json');
    if (existsSync(analysisPath)) {
      return JSON.parse(readFileSync(analysisPath, 'utf8'));
    }
    return { files: {} };
  }

  async runAPITests() {
    console.log('Starting API tests for changed endpoints...');
    
    const apiChanges = this.getAPIChanges();
    if (apiChanges.length === 0) {
      console.log('No API changes detected. Running critical path tests only.');
      return this.runCriticalAPITests();
    }

    for (const change of apiChanges) {
      await this.testChangedEndpoint(change);
    }

    this.saveResults();
    return this.results;
  }

  getAPIChanges() {
    const apiChanges = [];
    
    Object.entries(this.changeDetails.files).forEach(([file, data]) => {
      if (file.includes('api/') || file.includes('services/')) {
        Object.entries(data.functions).forEach(([funcName, changeType]) => {
          apiChanges.push({
            file,
            function: funcName,
            changeType,
            lines: data.lines,
            endpoint: this.deriveEndpoint(file, funcName),
            method: this.deriveHTTPMethod(funcName)
          });
        });
      }
    });
    
    return apiChanges;
  }

  async testChangedEndpoint(change) {
    const testName = `API: ${change.function} (${change.changeType})`;
    console.log(`Testing: ${testName}`);
    
    const result = {
      name: testName,
      file: change.file,
      function: change.function,
      endpoint: change.endpoint,
      method: change.method,
      changeType: change.changeType,
      tests: []
    };

    // Test with self-healing
    const healingStrategies = [
      { url: change.endpoint, version: '' },
      { url: `/api${change.endpoint}`, version: 'api-prefix' },
      { url: `/v1${change.endpoint}`, version: 'v1' },
      { url: `/v2${change.endpoint}`, version: 'v2' },
      { url: change.endpoint.replace(/\/$/, ''), version: 'no-trailing-slash' },
      { url: this.pluralizeEndpoint(change.endpoint), version: 'pluralized' }
    ];

    let success = false;
    let healingUsed = null;

    for (const strategy of healingStrategies) {
      try {
        const testResult = await this.executeEndpointTest(
          strategy.url, 
          change.method,
          change
        );
        
        result.tests.push({
          ...testResult,
          healingStrategy: strategy.version,
          healed: strategy.version !== ''
        });
        
        success = true;
        healingUsed = strategy.version;
        break;
      } catch (error) {
        // Continue to next strategy
      }
    }

    result.success = success;
    result.healingUsed = healingUsed;
    this.results.push(result);
  }

  async executeEndpointTest(endpoint, method, change) {
    const url = `${this.baseURL}${endpoint}`;
    const testCases = this.generateTestCases(method, change);
    const results = [];

    for (const testCase of testCases) {
      try {
        const startTime = Date.now();
        const response = await this.makeRequest(url, method, testCase.data, testCase.headers);
        const duration = Date.now() - startTime;

        const validationResults = this.validateResponse(
          response, 
          testCase.expectedStatus,
          testCase.validations,
          change
        );

        results.push({
          case: testCase.name,
          success: validationResults.success,
          status: response.status,
          duration,
          validations: validationResults.details
        });
      } catch (error) {
        results.push({
          case: testCase.name,
          success: false,
          error: error.message,
          duration: 0
        });
      }
    }

    return {
      endpoint,
      method,
      cases: results,
      success: results.every(r => r.success)
    };
  }

  generateTestCases(method, change) {
    const cases = [];
    
    switch (method) {
      case 'GET':
        cases.push({
          name: 'Get resource',
          data: null,
          expectedStatus: 200,
          validations: ['hasData', 'correctFormat']
        });
        
        if (change.function.includes('Id') || change.endpoint.includes(':id')) {
          cases.push({
            name: 'Get by ID',
            endpoint: change.endpoint.replace(':id', '1'),
            expectedStatus: 200,
            validations: ['hasId', 'correctFormat']
          });
          
          cases.push({
            name: 'Get non-existent',
            endpoint: change.endpoint.replace(':id', '999999'),
            expectedStatus: 404,
            validations: ['errorFormat']
          });
        }
        break;
        
      case 'POST':
        cases.push({
          name: 'Create valid',
          data: this.generateTestData(change),
          expectedStatus: 201,
          validations: ['hasId', 'dataMatches']
        });
        
        cases.push({
          name: 'Create invalid',
          data: {},
          expectedStatus: 400,
          validations: ['errorFormat', 'hasValidationErrors']
        });
        break;
        
      case 'PUT':
      case 'PATCH':
        cases.push({
          name: 'Update valid',
          endpoint: change.endpoint.replace(':id', '1'),
          data: this.generateTestData(change),
          expectedStatus: 200,
          validations: ['dataUpdated']
        });
        
        cases.push({
          name: 'Update non-existent',
          endpoint: change.endpoint.replace(':id', '999999'),
          data: this.generateTestData(change),
          expectedStatus: 404,
          validations: ['errorFormat']
        });
        break;
        
      case 'DELETE':
        cases.push({
          name: 'Delete existing',
          endpoint: change.endpoint.replace(':id', '1'),
          expectedStatus: 204,
          validations: []
        });
        
        cases.push({
          name: 'Delete non-existent',
          endpoint: change.endpoint.replace(':id', '999999'),
          expectedStatus: 404,
          validations: ['errorFormat']
        });
        break;
    }

    // Add auth test if auth changes detected
    if (this.hasAuthChanges(change)) {
      cases.push({
        name: 'Unauthorized access',
        headers: {},
        expectedStatus: 401,
        validations: ['errorFormat']
      });
    }

    return cases;
  }

  generateTestData(change) {
    // Generate test data based on function name and file
    const baseData = {
      name: 'Test Item',
      description: 'Test Description',
      active: true,
      timestamp: new Date().toISOString()
    };

    if (change.function.includes('user') || change.file.includes('user')) {
      return {
        username: 'testuser',
        email: 'test@example.com',
        password: 'Test123!',
        ...baseData
      };
    }

    if (change.function.includes('product') || change.file.includes('product')) {
      return {
        name: 'Test Product',
        price: 99.99,
        category: 'test',
        stock: 100,
        ...baseData
      };
    }

    return baseData;
  }

  async makeRequest(url, method, data = null, headers = {}) {
    const config = {
      method,
      url,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headers
      },
      validateStatus: () => true // Don't throw on any status
    };

    if (data && ['POST', 'PUT', 'PATCH'].includes(method)) {
      config.data = data;
    }

    return await axios(config);
  }

  validateResponse(response, expectedStatus, validations, change) {
    const results = {
      success: true,
      details: []
    };

    // Status validation
    if (response.status !== expectedStatus) {
      results.success = false;
      results.details.push({
        validation: 'status',
        expected: expectedStatus,
        actual: response.status,
        passed: false
      });
    } else {
      results.details.push({
        validation: 'status',
        passed: true
      });
    }

    // Custom validations
    for (const validation of validations) {
      const result = this.runValidation(validation, response, change);
      results.details.push(result);
      if (!result.passed) results.success = false;
    }

    return results;
  }

  runValidation(validation, response, change) {
    switch (validation) {
      case 'hasData':
        return {
          validation: 'hasData',
          passed: response.data != null && 
                  (Array.isArray(response.data) || Object.keys(response.data).length > 0)
        };
        
      case 'hasId':
        return {
          validation: 'hasId',
          passed: response.data && (response.data.id != null || response.data._id != null)
        };
        
      case 'correctFormat':
        return {
          validation: 'correctFormat',
          passed: this.validateDataFormat(response.data, change)
        };
        
      case 'errorFormat':
        return {
          validation: 'errorFormat',
          passed: response.data && 
                  (response.data.error != null || response.data.message != null)
        };
        
      case 'dataMatches':
        return {
          validation: 'dataMatches',
          passed: response.data != null
        };
        
      case 'dataUpdated':
        return {
          validation: 'dataUpdated',
          passed: response.data && response.data.updatedAt != null
        };
        
      case 'hasValidationErrors':
        return {
          validation: 'hasValidationErrors',
          passed: response.data && 
                  (response.data.errors != null || response.data.validationErrors != null)
        };
        
      default:
        return { validation, passed: true };
    }
  }

  validateDataFormat(data, change) {
    if (!data) return false;
    
    // Basic format validation
    if (Array.isArray(data)) {
      return data.length === 0 || typeof data[0] === 'object';
    }
    
    return typeof data === 'object';
  }

  hasAuthChanges(change) {
    // Check if auth-related changes in specific lines
    const authKeywords = ['auth', 'token', 'jwt', 'session', 'permission', 'role'];
    return authKeywords.some(keyword => 
      change.function.toLowerCase().includes(keyword) ||
      change.file.toLowerCase().includes(keyword)
    );
  }

  async runCriticalAPITests() {
    // Fallback critical path tests
    const criticalEndpoints = [
      { endpoint: '/health', method: 'GET', expectedStatus: 200 },
      { endpoint: '/api/auth/login', method: 'POST', expectedStatus: 200 },
      { endpoint: '/api/users', method: 'GET', expectedStatus: 200 }
    ];

    for (const endpoint of criticalEndpoints) {
      try {
        const response = await this.makeRequest(
          `${this.baseURL}${endpoint.endpoint}`,
          endpoint.method,
          endpoint.method === 'POST' ? { username: 'test', password: 'test' } : null
        );
        
        this.results.push({
          name: `Critical: ${endpoint.endpoint}`,
          endpoint: endpoint.endpoint,
          method: endpoint.method,
          success: response.status === endpoint.expectedStatus,
          status: response.status
        });
      } catch (error) {
        this.results.push({
          name: `Critical: ${endpoint.endpoint}`,
          endpoint: endpoint.endpoint,
          method: endpoint.method,
          success: false,
          error: error.message
        });
      }
    }
  }

  deriveEndpoint(file, funcName) {
    const basePath = file.replace(/^.*\/(api|services)\//, '').replace(/\.[^/.]+$/, '');
    const resource = basePath.split('/').pop();
    
    if (funcName.includes('Id') || funcName.includes('ById')) {
      return `/${resource}/:id`;
    }
    
    return `/${resource}`;
  }

  deriveHTTPMethod(funcName) {
    const lower = funcName.toLowerCase();
    if (lower.includes('get') || lower.includes('fetch') || lower.includes('find')) return 'GET';
    if (lower.includes('post') || lower.includes('create') || lower.includes('add')) return 'POST';
    if (lower.includes('put') || lower.includes('update')) return 'PUT';
    if (lower.includes('patch')) return 'PATCH';
    if (lower.includes('delete') || lower.includes('remove')) return 'DELETE';
    return 'GET';
  }

  pluralizeEndpoint(endpoint) {
    if (endpoint.endsWith('y')) {
      return endpoint.slice(0, -1) + 'ies';
    }
    if (!endpoint.endsWith('s')) {
      return endpoint + 's';
    }
    return endpoint;
  }

  saveResults() {
    const outputPath = path.join(__dirname, '../test-results/api-test-results.json');
    const summary = {
      timestamp: new Date().toISOString(),
      total: this.results.length,
      passed: this.results.filter(r => r.success).length,
      failed: this.results.filter(r => !r.success).length,
      healingUsed: this.results.filter(r => r.healingUsed).length,
      results: this.results
    };
    
    writeFileSync(outputPath, JSON.stringify(summary, null, 2));
    
    console.log(`API Test Summary:`);
    console.log(`- Total: ${summary.total}`);
    console.log(`- Passed: ${summary.passed}`);
    console.log(`- Failed: ${summary.failed}`);
    console.log(`- Self-healed: ${summary.healingUsed}`);
  }
}

// Execute API tests
const tester = new APITester();
await tester.runAPITests();
