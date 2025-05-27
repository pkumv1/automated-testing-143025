import { chromium, firefox, webkit } from '@playwright/test';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { SelfHealingTest, ChangeAwareTestGenerator } from './self-healing-framework.js';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class TestRunner {
  constructor() {
    this.results = {
      ui: [],
      api: [],
      visual: [],
      integration: [],
      healing: {
        attempts: 0,
        successful: 0,
        byStrategy: {}
      }
    };
    
    this.changeDetails = this.loadChangeDetails();
    this.browsers = ['chromium']; // Start with one, expand if needed
  }

  loadChangeDetails() {
    const analysisPath = path.join(__dirname, '../test-results/change-analysis.json');
    if (existsSync(analysisPath)) {
      return JSON.parse(readFileSync(analysisPath, 'utf8'));
    }
    return null;
  }

  async execute() {
    console.log(chalk.blue('Starting change-focused test execution...'));
    
    // Check if we have changes to test
    if (!this.changeDetails || Object.keys(this.changeDetails.files).length === 0) {
      console.log(chalk.yellow('No recent changes detected. Running critical path tests only.'));
      return await this.runCriticalPathTests();
    }

    console.log(chalk.green(`Found ${Object.keys(this.changeDetails.files).length} changed files`));
    
    // Generate tests based on changes
    const testGenerator = new ChangeAwareTestGenerator();
    const tests = await testGenerator.generateTests();
    
    console.log(chalk.green(`Generated ${tests.length} targeted tests`));
    
    // Group tests by type
    const uiTests = tests.filter(t => t.type === 'ui');
    const apiTests = tests.filter(t => t.type === 'api');
    const visualTests = tests.filter(t => t.type === 'visual');
    
    // Execute UI tests with self-healing
    if (uiTests.length > 0) {
      await this.runUITests(uiTests);
    }
    
    // Execute API tests (handled by api-tester.js)
    if (apiTests.length > 0) {
      console.log(chalk.blue(`API tests: ${apiTests.length} endpoints to test`));
      // API tests run separately via api-tester.js
    }
    
    // Execute visual tests if many UI changes
    if (visualTests.length > 0) {
      await this.runVisualTests(visualTests);
    }
    
    // Run integration tests for cross-file changes
    const crossFileChanges = this.detectCrossBoundaryChanges();
    if (crossFileChanges.length > 0) {
      await this.runIntegrationTests(crossFileChanges);
    }
    
    // Save results
    this.saveResults();
    this.printSummary();
  }

  async runUITests(tests) {
    console.log(chalk.blue(`\nExecuting ${tests.length} UI tests...`));
    
    for (const browserType of this.browsers) {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true
      });
      
      for (const test of tests) {
        console.log(chalk.gray(`Testing: ${test.name}`));
        
        const page = await context.newPage();
        const selfHealing = new SelfHealingTest(page);
        
        try {
          // Navigate to component/page
          const url = this.deriveTestURL(test.file);
          await page.goto(url);
          
          // Execute test actions with self-healing
          const testResult = {
            name: test.name,
            file: test.file,
            function: test.function,
            targetLines: test.targetLines,
            actions: []
          };
          
          for (const action of test.actions) {
            try {
              const actionResult = await this.executeAction(
                selfHealing, 
                action, 
                test.selectors
              );
              
              testResult.actions.push({
                type: action.type,
                success: true,
                healingUsed: actionResult.healingUsed
              });
            } catch (error) {
              testResult.actions.push({
                type: action.type,
                success: false,
                error: error.message
              });
            }
          }
          
          // Check if all actions passed
          testResult.success = testResult.actions.every(a => a.success);
          
          // Get healing stats
          const healingStats = selfHealing.getHealingStats();
          this.results.healing.attempts += healingStats.total;
          this.results.healing.successful += healingStats.successful;
          
          // Merge healing strategy stats
          Object.entries(healingStats.byStrategy).forEach(([strategy, count]) => {
            this.results.healing.byStrategy[strategy] = 
              (this.results.healing.byStrategy[strategy] || 0) + count;
          });
          
          this.results.ui.push(testResult);
          
        } catch (error) {
          this.results.ui.push({
            name: test.name,
            file: test.file,
            success: false,
            error: error.message
          });
        } finally {
          await page.close();
        }
      }
      
      await browser.close();
    }
  }

  async executeAction(selfHealing, action, selectors) {
    const result = { healingUsed: false };
    
    switch (action.type) {
      case 'click':
        await selfHealing.clickElement(selectors);
        
        // Verify response if needed
        if (action.verify === 'response') {
          await selfHealing.page.waitForLoadState('networkidle');
        }
        break;
        
      case 'input':
        await selfHealing.typeInElement(selectors, action.value || 'test input');
        
        // Verify validation if needed
        if (action.verify === 'validation') {
          // Check for validation messages
          const errorSelectors = {
            css: '.error-message',
            text: 'error',
            role: 'alert'
          };
          
          try {
            await selfHealing.waitForElement(errorSelectors, { timeout: 2000 });
          } catch {
            // No error is good for valid input
          }
        }
        break;
        
      case 'submit':
        await selfHealing.clickElement({
          ...selectors,
          role: 'button',
          text: 'Submit'
        });
        
        if (action.verify === 'success') {
          // Wait for success indicator
          await selfHealing.waitForElement({
            text: 'Success',
            css: '.success-message',
            role: 'status'
          }, { timeout: 5000 });
        }
        break;
    }
    
    // Check if healing was used
    const stats = selfHealing.getHealingStats();
    if (stats.total > 0 && stats.byStrategy['1'] !== stats.total) {
      result.healingUsed = true;
    }
    
    return result;
  }

  async runVisualTests(tests) {
    console.log(chalk.blue(`\nExecuting ${tests.length} visual regression tests...`));
    
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });
    
    for (const test of tests) {
      const page = await context.newPage();
      
      try {
        const url = this.deriveTestURL(test.file);
        await page.goto(url);
        await page.waitForLoadState('networkidle');
        
        // Take screenshot of changed area
        const screenshotPath = path.join(
          __dirname, 
          '../test-results/screenshots',
          `${path.basename(test.file, '.js')}-${Date.now()}.png`
        );
        
        mkdirSync(path.dirname(screenshotPath), { recursive: true });
        
        if (test.targetArea.scope === 'component') {
          await page.screenshot({ 
            path: screenshotPath,
            fullPage: true 
          });
        } else {
          // Try to capture specific element
          const element = await page.$('.changed-component');
          if (element) {
            await element.screenshot({ path: screenshotPath });
          } else {
            await page.screenshot({ path: screenshotPath });
          }
        }
        
        this.results.visual.push({
          name: test.name,
          file: test.file,
          screenshot: screenshotPath,
          targetArea: test.targetArea,
          success: true
        });
        
      } catch (error) {
        this.results.visual.push({
          name: test.name,
          file: test.file,
          success: false,
          error: error.message
        });
      } finally {
        await page.close();
      }
    }
    
    await browser.close();
  }

  async runIntegrationTests(crossFileChanges) {
    console.log(chalk.blue(`\nExecuting ${crossFileChanges.length} integration tests...`));
    
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    
    for (const change of crossFileChanges) {
      const page = await context.newPage();
      const selfHealing = new SelfHealingTest(page);
      
      try {
        // Test the integration between changed files
        const result = {
          name: `Integration: ${change.source} -> ${change.target}`,
          source: change.source,
          target: change.target,
          changePath: change.path,
          tests: []
        };
        
        // Navigate to source component
        await page.goto(this.deriveTestURL(change.source));
        
        // Trigger action that affects target
        if (change.type === 'api-call') {
          // Intercept API calls
          await page.route('**/api/**', route => {
            this.results.integration.push({
              type: 'api-intercept',
              endpoint: route.request().url(),
              method: route.request().method()
            });
            route.continue();
          });
        }
        
        // Execute integration flow
        const flowSelectors = {
          testId: 'integration-trigger',
          css: '[data-integration]',
          role: 'button'
        };
        
        await selfHealing.clickElement(flowSelectors);
        await page.waitForLoadState('networkidle');
        
        // Verify target was affected
        const verification = await this.verifyIntegration(page, change);
        
        result.success = verification.success;
        result.tests = verification.tests;
        
        this.results.integration.push(result);
        
      } catch (error) {
        this.results.integration.push({
          name: `Integration: ${change.source} -> ${change.target}`,
          success: false,
          error: error.message
        });
      } finally {
        await page.close();
      }
    }
    
    await browser.close();
  }

  async runCriticalPathTests() {
    console.log(chalk.yellow('Running critical path tests...'));
    
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const selfHealing = new SelfHealingTest(page);
    
    const criticalPaths = [
      {
        name: 'Homepage Load',
        url: 'http://localhost:3000',
        selectors: { css: 'body', testId: 'app-root' }
      },
      {
        name: 'Login Flow',
        url: 'http://localhost:3000/login',
        selectors: { testId: 'login-form', role: 'form' }
      },
      {
        name: 'Main Navigation',
        url: 'http://localhost:3000',
        selectors: { role: 'navigation', css: 'nav' }
      }
    ];
    
    for (const path of criticalPaths) {
      try {
        await page.goto(path.url);
        await selfHealing.waitForElement(path.selectors, { timeout: 10000 });
        
        this.results.ui.push({
          name: path.name,
          type: 'critical-path',
          success: true
        });
      } catch (error) {
        this.results.ui.push({
          name: path.name,
          type: 'critical-path',
          success: false,
          error: error.message
        });
      }
    }
    
    await browser.close();
  }

  detectCrossBoundaryChanges() {
    const crossChanges = [];
    const files = Object.keys(this.changeDetails.files);
    
    // Simple dependency detection
    files.forEach(sourceFile => {
      files.forEach(targetFile => {
        if (sourceFile === targetFile) return;
        
        const sourceData = this.changeDetails.files[sourceFile];
        const targetData = this.changeDetails.files[targetFile];
        
        // Check if source impacts target
        if (sourceFile.includes('api/') && targetFile.includes('components/')) {
          crossChanges.push({
            source: sourceFile,
            target: targetFile,
            type: 'api-ui',
            path: 'api->component'
          });
        }
        
        if (sourceFile.includes('store/') && targetFile.includes('components/')) {
          crossChanges.push({
            source: sourceFile,
            target: targetFile,
            type: 'state-ui',
            path: 'state->component'
          });
        }
      });
    });
    
    return crossChanges;
  }

  deriveTestURL(file) {
    const base = process.env.TEST_URL || 'http://localhost:3000';
    
    if (file.includes('pages/')) {
      const pageName = path.basename(file, path.extname(file));
      return `${base}/${pageName}`;
    }
    
    if (file.includes('components/')) {
      return `${base}/component-test`;
    }
    
    return base;
  }

  async verifyIntegration(page, change) {
    const verification = {
      success: true,
      tests: []
    };
    
    // Check network requests
    const requests = await page.evaluate(() => 
      window.performance.getEntriesByType('resource')
        .filter(r => r.name.includes('api'))
        .map(r => ({ url: r.name, duration: r.duration }))
    );
    
    verification.tests.push({
      type: 'network',
      passed: requests.length > 0,
      details: requests
    });
    
    // Check DOM updates
    const domChanged = await page.evaluate(() => {
      return document.body.getAttribute('data-updated') === 'true';
    });
    
    verification.tests.push({
      type: 'dom-update',
      passed: domChanged
    });
    
    verification.success = verification.tests.every(t => t.passed);
    
    return verification;
  }

  saveResults() {
    const outputPath = path.join(__dirname, '../test-results/test-execution-results.json');
    
    const summary = {
      timestamp: new Date().toISOString(),
      changeDetails: {
        filesAnalyzed: Object.keys(this.changeDetails.files).length,
        totalChangedLines: Object.values(this.changeDetails.files)
          .reduce((sum, f) => sum + f.lines.modified.length + f.lines.added.length, 0),
        functionsModified: Object.values(this.changeDetails.files)
          .reduce((sum, f) => sum + Object.keys(f.functions).length, 0)
      },
      results: {
        ui: {
          total: this.results.ui.length,
          passed: this.results.ui.filter(r => r.success).length,
          failed: this.results.ui.filter(r => !r.success).length
        },
        visual: {
          total: this.results.visual.length,
          passed: this.results.visual.filter(r => r.success).length
        },
        integration: {
          total: this.results.integration.length,
          passed: this.results.integration.filter(r => r.success).length
        }
      },
      healing: {
        ...this.results.healing,
        successRate: this.results.healing.attempts > 0 
          ? (this.results.healing.successful / this.results.healing.attempts * 100).toFixed(2)
          : 0
      },
      details: this.results
    };
    
    writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  }

  printSummary() {
    console.log(chalk.bold.blue('\n=== Test Execution Summary ==='));
    
    const uiPassed = this.results.ui.filter(r => r.success).length;
    const uiTotal = this.results.ui.length;
    
    console.log(chalk.green(`UI Tests: ${uiPassed}/${uiTotal} passed`));
    
    if (this.results.visual.length > 0) {
      const visualPassed = this.results.visual.filter(r => r.success).length;
      console.log(chalk.green(`Visual Tests: ${visualPassed}/${this.results.visual.length} passed`));
    }
    
    if (this.results.integration.length > 0) {
      const intPassed = this.results.integration.filter(r => r.success).length;
      console.log(chalk.green(`Integration Tests: ${intPassed}/${this.results.integration.length} passed`));
    }
    
    if (this.results.healing.attempts > 0) {
      console.log(chalk.yellow(`\nSelf-Healing Stats:`));
      console.log(`- Total attempts: ${this.results.healing.attempts}`);
      console.log(`- Successful: ${this.results.healing.successful}`);
      console.log(`- Success rate: ${this.results.healing.successRate}%`);
      
      console.log(`- By strategy:`);
      Object.entries(this.results.healing.byStrategy).forEach(([strategy, count]) => {
        const strategyNames = {
          '1': 'ID/TestID',
          '2': 'CSS',
          '3': 'XPath',
          '4': 'Text',
          '5': 'Visual',
          '6': 'AI Fallback',
          'failed': 'Failed'
        };
        console.log(`  ${strategyNames[strategy] || strategy}: ${count}`);
      });
    }
    
    // Print changed coverage
    if (this.changeDetails) {
      console.log(chalk.cyan(`\nChange Coverage:`));
      console.log(`- Files tested: ${Object.keys(this.changeDetails.files).length}`);
      console.log(`- Functions covered: ${
        Object.values(this.changeDetails.files)
          .reduce((sum, f) => sum + Object.keys(f.functions).length, 0)
      }`);
    }
  }
}

// Execute tests
const runner = new TestRunner();
await runner.execute();
