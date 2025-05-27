import { chromium, firefox, webkit } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class SelfHealingTest {
  constructor(page) {
    this.page = page;
    this.healingAttempts = [];
  }

  async findElement(selectors, context = null) {
    const strategies = [
      // Tier 1: ID/data-testid
      async () => {
        if (selectors.testId) return this.page.locator(`[data-testid="${selectors.testId}"]`);
        if (selectors.id) return this.page.locator(`#${selectors.id}`);
      },
      
      // Tier 2: CSS with context
      async () => {
        if (selectors.css) {
          const base = context || this.page;
          return base.locator(selectors.css);
        }
      },
      
      // Tier 3: XPath relative
      async () => {
        if (selectors.xpath) return this.page.locator(`xpath=${selectors.xpath}`);
      },
      
      // Tier 4: Text matching
      async () => {
        if (selectors.text) {
          return this.page.locator(`text=${selectors.text}`);
        }
        if (selectors.partialText) {
          return this.page.locator(`text=/${selectors.partialText}/i`);
        }
      },
      
      // Tier 5: Visual pattern (minimal)
      async () => {
        if (selectors.role && selectors.name) {
          return this.page.getByRole(selectors.role, { name: selectors.name });
        }
      },
      
      // Tier 6: AI detection fallback
      async () => {
        if (selectors.description) {
          // Try multiple combinations
          const attempts = [
            this.page.getByText(selectors.description, { exact: false }),
            this.page.getByLabel(selectors.description),
            this.page.getByPlaceholder(selectors.description)
          ];
          
          for (const attempt of attempts) {
            const count = await attempt.count();
            if (count === 1) return attempt;
          }
        }
      }
    ];

    for (let i = 0; i < strategies.length; i++) {
      try {
        const element = await strategies[i]();
        if (element && await element.count() > 0) {
          this.healingAttempts.push({
            selectors,
            strategy: i + 1,
            success: true,
            timestamp: Date.now()
          });
          return element;
        }
      } catch (error) {
        // Continue to next strategy
      }
    }

    this.healingAttempts.push({
      selectors,
      strategy: 'failed',
      success: false,
      timestamp: Date.now()
    });
    
    throw new Error(`Element not found with selectors: ${JSON.stringify(selectors)}`);
  }

  async clickElement(selectors) {
    const element = await this.findElement(selectors);
    await element.click();
  }

  async typeInElement(selectors, text) {
    const element = await this.findElement(selectors);
    await element.fill(text);
  }

  async waitForElement(selectors, options = {}) {
    const element = await this.findElement(selectors);
    await element.waitFor(options);
    return element;
  }

  getHealingStats() {
    const total = this.healingAttempts.length;
    const successful = this.healingAttempts.filter(a => a.success).length;
    const byStrategy = {};
    
    this.healingAttempts.forEach(attempt => {
      const key = attempt.strategy.toString();
      byStrategy[key] = (byStrategy[key] || 0) + 1;
    });
    
    return {
      total,
      successful,
      successRate: total > 0 ? (successful / total * 100).toFixed(2) : 0,
      byStrategy
    };
  }
}

export class ChangeAwareTestGenerator {
  constructor() {
    this.changeDetails = this.loadChangeDetails();
    this.testTargets = this.loadTestTargets();
  }

  loadChangeDetails() {
    const path = `${__dirname}/../test-results/change-analysis.json`;
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8'));
    }
    return { files: {} };
  }

  loadTestTargets() {
    const path = `${__dirname}/../test-results/test-targets.json`;
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8'));
    }
    return { uiPaths: [], apiEndpoints: [], specificFunctions: [] };
  }

  async generateTests() {
    const tests = [];
    
    // Generate UI tests for changed components
    for (const [file, changes] of Object.entries(this.changeDetails.files)) {
      if (file.includes('components/') || file.includes('pages/')) {
        tests.push(...this.generateUITests(file, changes));
      }
      
      // Generate API tests for changed endpoints
      if (file.includes('api/') || file.includes('services/')) {
        tests.push(...this.generateAPITests(file, changes));
      }
    }
    
    return tests;
  }

  generateUITests(file, changes) {
    const tests = [];
    
    // Test each modified function
    Object.entries(changes.functions).forEach(([funcName, changeType]) => {
      if (changeType === 'deleted') return;
      
      const test = {
        name: `UI Test: ${funcName} in ${file}`,
        file,
        function: funcName,
        changeType,
        targetLines: changes.lines.modified,
        type: 'ui',
        selectors: this.generateSelectors(file, funcName),
        actions: this.generateActions(funcName, changes)
      };
      
      tests.push(test);
    });
    
    // Visual regression for significant changes
    if (changes.lines.modified.length > 10 || changes.lines.added.length > 10) {
      tests.push({
        name: `Visual Test: ${file}`,
        file,
        type: 'visual',
        targetArea: this.calculateUIImpactArea(changes),
        threshold: 0.1
      });
    }
    
    return tests;
  }

  generateAPITests(file, changes) {
    const tests = [];
    
    Object.entries(changes.functions).forEach(([funcName, changeType]) => {
      if (changeType === 'deleted') return;
      
      const endpoint = this.deriveEndpoint(file, funcName);
      const method = this.deriveHTTPMethod(funcName);
      
      tests.push({
        name: `API Test: ${funcName} in ${file}`,
        file,
        function: funcName,
        endpoint,
        method,
        changeType,
        targetLines: changes.lines.modified,
        type: 'api',
        validations: this.generateValidations(funcName, changes)
      });
    });
    
    return tests;
  }

  generateSelectors(file, funcName) {
    // Smart selector generation based on component
    const componentName = path.basename(file, path.extname(file));
    
    return {
      testId: `${componentName}-${funcName}`.toLowerCase(),
      css: `.${componentName}`,
      role: this.inferRole(funcName),
      description: `${componentName} ${funcName}`,
      fallback: {
        text: funcName.replace(/([A-Z])/g, ' $1').trim(),
        partialText: componentName
      }
    };
  }

  generateActions(funcName, changes) {
    const actions = [];
    
    if (funcName.includes('handle') || funcName.includes('on')) {
      actions.push({ type: 'click', verify: 'response' });
    }
    
    if (funcName.includes('validate') || funcName.includes('check')) {
      actions.push({ type: 'input', value: 'test', verify: 'validation' });
    }
    
    if (funcName.includes('submit') || funcName.includes('save')) {
      actions.push({ type: 'submit', verify: 'success' });
    }
    
    return actions;
  }

  generateValidations(funcName, changes) {
    const validations = [];
    
    // Validation based on function name patterns
    if (funcName.includes('get')) {
      validations.push({ status: 200, hasData: true });
    }
    if (funcName.includes('create') || funcName.includes('post')) {
      validations.push({ status: 201, hasId: true });
    }
    if (funcName.includes('update') || funcName.includes('put')) {
      validations.push({ status: 200, dataUpdated: true });
    }
    if (funcName.includes('delete')) {
      validations.push({ status: 204 });
    }
    
    // Add validation for specific changed lines
    if (changes.lines.modified.some(line => line >= 10 && line <= 20)) {
      validations.push({ customValidation: 'auth-check' });
    }
    
    return validations;
  }

  deriveEndpoint(file, funcName) {
    const basePath = file.replace(/^.*\/(api|services)\//, '').replace(/\.[^/.]+$/, '');
    const resource = basePath.split('/').pop();
    
    if (funcName.includes('get') && funcName.includes('Id')) {
      return `/api/${resource}/:id`;
    }
    if (funcName.includes('get')) {
      return `/api/${resource}`;
    }
    if (funcName.includes('create') || funcName.includes('post')) {
      return `/api/${resource}`;
    }
    if (funcName.includes('update') || funcName.includes('put')) {
      return `/api/${resource}/:id`;
    }
    if (funcName.includes('delete')) {
      return `/api/${resource}/:id`;
    }
    
    return `/api/${resource}`;
  }

  deriveHTTPMethod(funcName) {
    const lowerFunc = funcName.toLowerCase();
    if (lowerFunc.includes('get') || lowerFunc.includes('fetch')) return 'GET';
    if (lowerFunc.includes('post') || lowerFunc.includes('create')) return 'POST';
    if (lowerFunc.includes('put') || lowerFunc.includes('update')) return 'PUT';
    if (lowerFunc.includes('patch')) return 'PATCH';
    if (lowerFunc.includes('delete') || lowerFunc.includes('remove')) return 'DELETE';
    return 'GET';
  }

  inferRole(funcName) {
    if (funcName.includes('button') || funcName.includes('click')) return 'button';
    if (funcName.includes('input') || funcName.includes('field')) return 'textbox';
    if (funcName.includes('select') || funcName.includes('dropdown')) return 'combobox';
    if (funcName.includes('check')) return 'checkbox';
    if (funcName.includes('radio')) return 'radio';
    if (funcName.includes('link')) return 'link';
    return 'button';
  }

  calculateUIImpactArea(changes) {
    const minLine = Math.min(...changes.lines.modified, ...changes.lines.added);
    const maxLine = Math.max(...changes.lines.modified, ...changes.lines.added);
    
    return {
      startLine: minLine,
      endLine: maxLine,
      scope: maxLine - minLine > 50 ? 'component' : 'partial'
    };
  }
}

export class SelfHealingAPI {
  constructor(baseURL = 'http://localhost:3000') {
    this.baseURL = baseURL;
    this.endpoints = new Map();
  }

  async testEndpoint(config, changeLocations) {
    const tests = changeLocations.map(change => ({
      endpoint: change.endpoint,
      method: change.httpMethod,
      focusOn: change.modifiedLogic
    }));
    
    const results = [];
    
    for (const test of tests) {
      try {
        const result = await this.executeWithFallbacks(test);
        results.push(result);
      } catch (error) {
        results.push({
          ...test,
          success: false,
          error: error.message,
          healed: false
        });
      }
    }
    
    return results;
  }

  async executeWithFallbacks(test) {
    const strategies = [
      // Try exact endpoint
      async () => await this.executeRequest(test.endpoint, test.method),
      
      // Try with API versioning
      async () => await this.executeRequest(`/v1${test.endpoint}`, test.method),
      async () => await this.executeRequest(`/v2${test.endpoint}`, test.method),
      
      // Try pluralization
      async () => {
        const pluralized = test.endpoint.replace(/(\w+)\/?$/, '$1s');
        return await this.executeRequest(pluralized, test.method);
      },
      
      // Try without trailing slash
      async () => {
        const cleaned = test.endpoint.replace(/\/$/, '');
        return await this.executeRequest(cleaned, test.method);
      }
    ];

    let lastError;
    for (let i = 0; i < strategies.length; i++) {
      try {
        const result = await strategies[i]();
        return {
          ...test,
          ...result,
          success: true,
          healingStrategy: i,
          healed: i > 0
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  async executeRequest(endpoint, method, data = null) {
    const url = `${this.baseURL}${endpoint}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (data && ['POST', 'PUT', 'PATCH'].includes(method)) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);
    const responseData = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(`${method} ${endpoint} failed: ${response.status}`);
    }

    return {
      status: response.status,
      data: responseData,
      headers: Object.fromEntries(response.headers.entries())
    };
  }
}
