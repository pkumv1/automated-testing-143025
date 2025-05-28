import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class ReportGenerator {
  constructor() {
    this.results = this.loadAllResults();
    this.changeDetails = this.loadChangeDetails();
  }

  loadAllResults() {
    const results = {};
    const resultFiles = [
      'change-analysis.json',
      'test-execution-results.json',
      'api-test-results.json',
      'advanced-test-results.json'
    ];

    resultFiles.forEach(file => {
      const filePath = path.join(__dirname, '../test-results', file);
      if (existsSync(filePath)) {
        const key = file.replace('.json', '').replace(/-/g, '_');
        results[key] = JSON.parse(readFileSync(filePath, 'utf8'));
      }
    });

    return results;
  }

  loadChangeDetails() {
    const analysisPath = path.join(__dirname, '../test-results/change-analysis.json');
    if (existsSync(analysisPath)) {
      return JSON.parse(readFileSync(analysisPath, 'utf8'));
    }
    return null;
  }

  async generate() {
    // Check available messages (simulated)
    const messagesRemaining = 10; // In real scenario, this would be tracked

    if (messagesRemaining > 5) {
      await this.generateInteractiveReport();
    } else {
      await this.generateSimpleReport();
    }
  }

  async generateInteractiveReport() {
    console.log('Generating interactive report with full features...');

    const reportData = this.prepareReportData();
    
    // Create React-based interactive dashboard
    const htmlContent = this.createInteractiveHTML(reportData);
    const jsContent = this.createInteractiveJS(reportData);
    const cssContent = this.createInteractiveCSS();

    // Save to docs directory for GitHub Pages
    const docsDir = path.join(__dirname, '../docs');
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(path.join(docsDir, 'index.html'), htmlContent);
    writeFileSync(path.join(docsDir, 'app.js'), jsContent);
    writeFileSync(path.join(docsDir, 'styles.css'), cssContent);
    writeFileSync(path.join(docsDir, 'data.json'), JSON.stringify(reportData, null, 2));

    // Create GitHub Pages config
    writeFileSync(path.join(docsDir, '_config.yml'), 'theme: jekyll-theme-minimal');

    console.log('Interactive report generated at /docs/index.html');
  }

  async generateSimpleReport() {
    console.log('Generating simple markdown report...');

    const reportData = this.prepareReportData();
    const markdown = this.createMarkdownReport(reportData);

    const outputPath = path.join(__dirname, '../test-results/REPORT.md');
    writeFileSync(outputPath, markdown);

    console.log('Simple report generated at /test-results/REPORT.md');
  }

  prepareReportData() {
    const data = {
      timestamp: new Date().toISOString(),
      summary: {
        filesChanged: 0,
        linesChanged: 0,
        functionsModified: 0,
        testsExecuted: 0,
        testsPassed: 0,
        testsFailed: 0,
        coveragePercent: 0,
        healingSuccessRate: 0
      },
      changeDetails: {
        byFile: {},
        byFunction: [],
        byLine: []
      },
      testResults: {
        ui: [],
        api: [],
        visual: [],
        integration: [],
        crossBrowser: {},
        performance: []
      },
      criticalIssues: [],
      healingMetrics: {},
      performanceMetrics: {}
    };

    // Process change analysis
    if (this.results.change_analysis) {
      const changes = this.results.change_analysis;
      data.summary.filesChanged = Object.keys(changes.files).length;
      
      Object.entries(changes.files).forEach(([file, fileData]) => {
        data.changeDetails.byFile[file] = {
          lines: fileData.lines,
          functions: fileData.functions,
          impact: fileData.impact
        };

        data.summary.linesChanged += 
          fileData.lines.added.length + 
          fileData.lines.modified.length;
        
        data.summary.functionsModified += Object.keys(fileData.functions).length;

        // Track line-level changes
        fileData.lines.modified.forEach(line => {
          data.changeDetails.byLine.push({
            file,
            line,
            type: 'modified'
          });
        });

        // Track function-level changes
        Object.entries(fileData.functions).forEach(([func, type]) => {
          data.changeDetails.byFunction.push({
            file,
            function: func,
            changeType: type
          });
        });
      });
    }

    // Process test execution results
    if (this.results.test_execution_results) {
      const exec = this.results.test_execution_results;
      
      if (exec.results) {
        data.testResults.ui = exec.results.ui || [];
        data.testResults.visual = exec.results.visual || [];
        data.testResults.integration = exec.results.integration || [];
        
        data.summary.testsExecuted = exec.results.ui.length + 
          exec.results.visual.length + 
          exec.results.integration.length;
        
        data.summary.testsPassed = 
          exec.results.ui.filter(t => t.success).length +
          exec.results.visual.filter(t => t.success).length +
          exec.results.integration.filter(t => t.success).length;
      }

      if (exec.healing) {
        data.healingMetrics = exec.healing;
        data.summary.healingSuccessRate = exec.healing.successRate || 0;
      }
    }

    // Process API test results
    if (this.results.api_test_results) {
      const api = this.results.api_test_results;
      data.testResults.api = api.results || [];
      data.summary.testsExecuted += api.total || 0;
      data.summary.testsPassed += api.passed || 0;
    }

    // Process advanced test results
    if (this.results.advanced_test_results) {
      const adv = this.results.advanced_test_results;
      
      if (adv.crossBrowser) {
        data.testResults.crossBrowser = adv.details.crossBrowser || {};
      }
      
      if (adv.loadTest) {
        data.performanceMetrics = {
          avgThroughput: adv.loadTest.avgThroughput,
          avgResponseTime: adv.loadTest.avgResponseTime,
          endpoints: adv.details.loadTest || []
        };
      }
    }

    // Calculate coverage
    data.summary.testsFailed = data.summary.testsExecuted - data.summary.testsPassed;
    data.summary.coveragePercent = data.summary.functionsModified > 0
      ? ((data.summary.testsPassed / data.summary.functionsModified) * 100).toFixed(2)
      : 0;

    // Identify critical issues
    data.criticalIssues = this.identifyCriticalIssues(data);

    return data;
  }

  identifyCriticalIssues(data) {
    const issues = [];

    // Check for failed UI tests
    data.testResults.ui.forEach(test => {
      if (!test.success) {
        issues.push({
          severity: 'high',
          type: 'ui-failure',
          location: `${test.file}:${test.targetLines?.join(',')}`,
          function: test.function,
          message: test.error || 'UI test failed'
        });
      }
    });

    // Check for failed API tests
    data.testResults.api.forEach(test => {
      if (!test.success) {
        issues.push({
          severity: 'critical',
          type: 'api-failure',
          location: `${test.file}:${test.function}`,
          endpoint: test.endpoint,
          message: 'API endpoint test failed'
        });
      }
    });

    // Check for performance regressions
    if (data.performanceMetrics.endpoints) {
      data.performanceMetrics.endpoints.forEach(endpoint => {
        if (endpoint.metrics?.avgResponseTime > 1000) {
          issues.push({
            severity: 'medium',
            type: 'performance',
            location: `${endpoint.file}:${endpoint.targetLines?.join(',')}`,
            endpoint: endpoint.endpoint,
            message: `Slow response: ${endpoint.metrics.avgResponseTime}ms`
          });
        }
      });
    }

    // Check healing metrics
    if (data.healingMetrics.successRate < 80) {
      issues.push({
        severity: 'medium',
        type: 'healing',
        message: `Low healing success rate: ${data.healingMetrics.successRate}%`
      });
    }

    // Sort by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return issues.slice(0, 10); // Top 10 issues
  }

  createInteractiveHTML(data) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>E2E Test Report - ${new Date().toLocaleDateString()}</title>
    <link rel="stylesheet" href="styles.css">
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
    <div id="root"></div>
    <script type="text/babel" src="app.js"></script>
</body>
</html>`;
  }

  createInteractiveJS(data) {
    return `const { useState, useEffect } = React;

const TestReport = () => {
  const [data, setData] = useState(null);
  const [activeView, setActiveView] = useState('summary');
  const [selectedFile, setSelectedFile] = useState(null);

  useEffect(() => {
    fetch('data.json')
      .then(res => res.json())
      .then(setData)
      .catch(console.error);
  }, []);

  if (!data) return <div className="loading">Loading...</div>;

  return (
    <div className="container">
      <header>
        <h1>E2E Test Report</h1>
        <p className="timestamp">{new Date(data.timestamp).toLocaleString()}</p>
      </header>

      <nav className="tabs">
        <button 
          className={activeView === 'summary' ? 'active' : ''} 
          onClick={() => setActiveView('summary')}
        >
          Summary
        </button>
        <button 
          className={activeView === 'changes' ? 'active' : ''} 
          onClick={() => setActiveView('changes')}
        >
          Changes
        </button>
        <button 
          className={activeView === 'tests' ? 'active' : ''} 
          onClick={() => setActiveView('tests')}
        >
          Test Results
        </button>
        <button 
          className={activeView === 'issues' ? 'active' : ''} 
          onClick={() => setActiveView('issues')}
        >
          Issues
        </button>
      </nav>

      <main>
        {activeView === 'summary' && <SummaryView data={data} />}
        {activeView === 'changes' && <ChangesView data={data} onFileSelect={setSelectedFile} />}
        {activeView === 'tests' && <TestsView data={data} />}
        {activeView === 'issues' && <IssuesView data={data} />}
      </main>
    </div>
  );
};

const SummaryView = ({ data }) => {
  const { summary } = data;
  
  return (
    <div className="summary-view">
      <div className="metrics-grid">
        <div className="metric-card">
          <h3>Files Changed</h3>
          <div className="metric-value">{summary.filesChanged}</div>
        </div>
        <div className="metric-card">
          <h3>Lines Modified</h3>
          <div className="metric-value">{summary.linesChanged}</div>
        </div>
        <div className="metric-card">
          <h3>Functions Changed</h3>
          <div className="metric-value">{summary.functionsModified}</div>
        </div>
        <div className="metric-card">
          <h3>Test Coverage</h3>
          <div className="metric-value">{summary.coveragePercent}%</div>
        </div>
      </div>

      <div className="test-summary">
        <h2>Test Execution Summary</h2>
        <div className="test-stats">
          <div className="stat passed">
            <span className="label">Passed</span>
            <span className="value">{summary.testsPassed}</span>
          </div>
          <div className="stat failed">
            <span className="label">Failed</span>
            <span className="value">{summary.testsFailed}</span>
          </div>
          <div className="stat total">
            <span className="label">Total</span>
            <span className="value">{summary.testsExecuted}</span>
          </div>
        </div>
      </div>

      {data.healingMetrics && (
        <div className="healing-summary">
          <h2>Self-Healing Performance</h2>
          <div className="healing-rate">
            Success Rate: {data.healingMetrics.successRate}%
          </div>
          <div className="healing-breakdown">
            {Object.entries(data.healingMetrics.byStrategy || {}).map(([strategy, count]) => (
              <div key={strategy} className="strategy">
                <span>{strategy}:</span> <span>{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const ChangesView = ({ data, onFileSelect }) => {
  const { changeDetails } = data;
  
  return (
    <div className="changes-view">
      <h2>Code Changes by File</h2>
      <div className="file-list">
        {Object.entries(changeDetails.byFile).map(([file, details]) => (
          <div key={file} className="file-card" onClick={() => onFileSelect(file)}>
            <h3>{file}</h3>
            <div className="change-stats">
              <span className="added">+{details.lines.added.length}</span>
              <span className="modified">~{details.lines.modified.length}</span>
              <span className="deleted">-{details.lines.deleted.length}</span>
            </div>
            <div className="functions">
              {Object.entries(details.functions).map(([func, type]) => (
                <span key={func} className={`function-tag ${type}`}>
                  {func}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <h2>Function-Level Changes</h2>
      <table className="changes-table">
        <thead>
          <tr>
            <th>File</th>
            <th>Function</th>
            <th>Change Type</th>
          </tr>
        </thead>
        <tbody>
          {changeDetails.byFunction.map((change, idx) => (
            <tr key={idx}>
              <td>{change.file}</td>
              <td>{change.function}</td>
              <td className={`change-type ${change.changeType}`}>
                {change.changeType}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const TestsView = ({ data }) => {
  const { testResults } = data;
  
  return (
    <div className="tests-view">
      <h2>UI Test Results</h2>
      <div className="test-list">
        {testResults.ui.map((test, idx) => (
          <div key={idx} className={`test-card ${test.success ? 'passed' : 'failed'}`}>
            <h4>{test.name}</h4>
            <p>File: {test.file}</p>
            <p>Function: {test.function}</p>
            {test.error && <p className="error">{test.error}</p>}
          </div>
        ))}
      </div>

      <h2>API Test Results</h2>
      <div className="test-list">
        {testResults.api.map((test, idx) => (
          <div key={idx} className={`test-card ${test.success ? 'passed' : 'failed'}`}>
            <h4>{test.name}</h4>
            <p>Endpoint: {test.endpoint}</p>
            <p>Method: {test.method}</p>
            {test.healingUsed && <span className="healing-badge">Self-healed</span>}
          </div>
        ))}
      </div>

      {Object.keys(testResults.crossBrowser).length > 0 && (
        <>
          <h2>Cross-Browser Results</h2>
          <div className="browser-matrix">
            {Object.entries(testResults.crossBrowser).map(([component, browsers]) => (
              <div key={component} className="component-browsers">
                <h4>{component}</h4>
                <div className="browser-results">
                  {Object.entries(browsers).map(([browser, result]) => (
                    <div key={browser} className={`browser ${result.success ? 'pass' : 'fail'}`}>
                      {browser}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

const IssuesView = ({ data }) => {
  const { criticalIssues } = data;
  
  return (
    <div className="issues-view">
      <h2>Critical Issues ({criticalIssues.length})</h2>
      <div className="issues-list">
        {criticalIssues.map((issue, idx) => (
          <div key={idx} className={`issue-card severity-${issue.severity}`}>
            <div className="issue-header">
              <span className="severity">{issue.severity.toUpperCase()}</span>
              <span className="type">{issue.type}</span>
            </div>
            <div className="issue-details">
              <p className="location">{issue.location}</p>
              <p className="message">{issue.message}</p>
              {issue.endpoint && <p className="endpoint">Endpoint: {issue.endpoint}</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

ReactDOM.render(<TestReport />, document.getElementById('root'));`;
  }

  createInteractiveCSS() {
    return `* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #0a0a0a;
  color: #e0e0e0;
  line-height: 1.6;
}

.container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 20px;
}

header {
  text-align: center;
  padding: 40px 0;
  border-bottom: 1px solid #333;
}

h1 {
  font-size: 2.5em;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin-bottom: 10px;
}

.timestamp {
  color: #888;
  font-size: 0.9em;
}

.tabs {
  display: flex;
  gap: 10px;
  margin: 30px 0;
  border-bottom: 1px solid #333;
}

.tabs button {
  background: none;
  border: none;
  color: #888;
  padding: 15px 30px;
  cursor: pointer;
  font-size: 1em;
  transition: all 0.3s;
  position: relative;
}

.tabs button:hover {
  color: #fff;
}

.tabs button.active {
  color: #667eea;
}

.tabs button.active::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 0;
  right: 0;
  height: 2px;
  background: #667eea;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 20px;
  margin: 30px 0;
}

.metric-card {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 30px;
  text-align: center;
  transition: transform 0.3s, box-shadow 0.3s;
}

.metric-card:hover {
  transform: translateY(-5px);
  box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3);
}

.metric-card h3 {
  color: #888;
  font-size: 0.9em;
  text-transform: uppercase;
  margin-bottom: 10px;
}

.metric-value {
  font-size: 2.5em;
  font-weight: bold;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.test-summary {
  margin: 40px 0;
}

.test-stats {
  display: flex;
  gap: 20px;
  justify-content: center;
  margin: 20px 0;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px 40px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
}

.stat.passed {
  border: 1px solid #4ade80;
}

.stat.failed {
  border: 1px solid #f87171;
}

.stat .label {
  font-size: 0.9em;
  color: #888;
  margin-bottom: 5px;
}

.stat .value {
  font-size: 2em;
  font-weight: bold;
}

.stat.passed .value {
  color: #4ade80;
}

.stat.failed .value {
  color: #f87171;
}

.file-card {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 20px;
  margin: 10px 0;
  cursor: pointer;
  transition: all 0.3s;
}

.file-card:hover {
  background: rgba(255, 255, 255, 0.08);
  transform: translateX(5px);
}

.change-stats {
  display: flex;
  gap: 15px;
  margin: 10px 0;
}

.change-stats span {
  padding: 5px 10px;
  border-radius: 5px;
  font-size: 0.9em;
}

.added {
  background: rgba(74, 222, 128, 0.2);
  color: #4ade80;
}

.modified {
  background: rgba(251, 191, 36, 0.2);
  color: #fbbf24;
}

.deleted {
  background: rgba(248, 113, 113, 0.2);
  color: #f87171;
}

.function-tag {
  display: inline-block;
  padding: 3px 10px;
  margin: 2px;
  border-radius: 15px;
  font-size: 0.85em;
  background: rgba(102, 126, 234, 0.2);
  color: #667eea;
}

.test-card {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  padding: 15px;
  margin: 10px 0;
  border-left: 3px solid;
}

.test-card.passed {
  border-color: #4ade80;
}

.test-card.failed {
  border-color: #f87171;
}

.healing-badge {
  background: #fbbf24;
  color: #000;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.8em;
}

.issue-card {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  padding: 20px;
  margin: 15px 0;
  border-left: 4px solid;
}

.severity-critical {
  border-color: #dc2626;
}

.severity-high {
  border-color: #f87171;
}

.severity-medium {
  border-color: #fbbf24;
}

.issue-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 10px;
}

.severity {
  font-weight: bold;
  font-size: 0.9em;
}

.browser-matrix {
  display: grid;
  gap: 20px;
  margin: 20px 0;
}

.browser-results {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.browser {
  padding: 5px 15px;
  border-radius: 20px;
  font-size: 0.9em;
}

.browser.pass {
  background: rgba(74, 222, 128, 0.2);
  color: #4ade80;
}

.browser.fail {
  background: rgba(248, 113, 113, 0.2);
  color: #f87171;
}

.loading {
  text-align: center;
  padding: 50px;
  font-size: 1.2em;
  color: #888;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

main > div {
  animation: fadeIn 0.5s ease-out;
}`;
  }

  createMarkdownReport(data) {
    const { summary, changeDetails, testResults, criticalIssues } = data;

    return `# Test Results ${new Date().toLocaleDateString()}

## Change Location Summary
### Modified Files: ${summary.filesChanged}

| File | Lines Changed | Functions Modified | Test Coverage |
|------|--------------|-------------------|---------------|
${Object.entries(changeDetails.byFile).map(([file, details]) => 
  `| ${file} | ${details.lines.added.length} added, ${details.lines.modified.length} modified | ${Object.keys(details.functions).join(', ')} | ${this.calculateFileCoverage(file, testResults)}% |`
).join('\n')}

## Function-Level Results
${changeDetails.byFunction.map(change => 
  `- \`${change.file}:${change.function}()\`: ${this.getFunctionTestStatus(change, testResults)}`
).join('\n')}

## Critical Metrics
- Changed Code Coverage: ${summary.coveragePercent}%
- UI Healing Rate: ${summary.healingSuccessRate}%
- API Success Rate: ${this.calculateAPISuccessRate(testResults.api)}%

## Issues by Location
${criticalIssues.slice(0, 5).map((issue, idx) => 
  `${idx + 1}. [${issue.location}] - ${issue.message}`
).join('\n')}

## Data Tables
\`\`\`json
${JSON.stringify({
  summary,
  changeLocationDetails: changeDetails.byLine.slice(0, 20),
  healingMetrics: data.healingMetrics,
  performanceMetrics: data.performanceMetrics
}, null, 2)}
\`\`\`
`;
  }

  calculateFileCoverage(file, testResults) {
    const relevantTests = [
      ...testResults.ui.filter(t => t.file === file),
      ...testResults.api.filter(t => t.file === file)
    ];
    
    if (relevantTests.length === 0) return 0;
    
    const passed = relevantTests.filter(t => t.success).length;
    return ((passed / relevantTests.length) * 100).toFixed(0);
  }

  getFunctionTestStatus(change, testResults) {
    const tests = [
      ...testResults.ui.filter(t => t.file === change.file && t.function === change.function),
      ...testResults.api.filter(t => t.file === change.file && t.function === change.function)
    ];
    
    if (tests.length === 0) return '⚠️ Not tested';
    if (tests.every(t => t.success)) return `✓ Passed (${tests.length} tests)`;
    
    const failed = tests.filter(t => !t.success).length;
    return `⚠️ ${failed} issue${failed > 1 ? 's' : ''} found`;
  }

  calculateAPISuccessRate(apiTests) {
    if (apiTests.length === 0) return 100;
    const passed = apiTests.filter(t => t.success).length;
    return ((passed / apiTests.length) * 100).toFixed(0);
  }
}

// Execute report generation
const generator = new ReportGenerator();
await generator.generate();
