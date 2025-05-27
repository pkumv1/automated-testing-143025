import simpleGit from 'simple-git';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { glob } from 'glob';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const git = simpleGit();

class ChangeAnalyzer {
  async detectCodeChanges(options = {}) {
    const changes = {
      files: {},
      summary: { added: 0, modified: 0, deleted: 0, totalChanges: 0 }
    };

    try {
      // Get git diff with line numbers
      const diffSummary = await git.diffSummary(['HEAD~1', 'HEAD']);
      
      for (const file of diffSummary.files) {
        if (!this.isTestableFile(file.file)) continue;
        
        const fileChange = {
          file: file.file,
          lines: { added: [], deleted: [], modified: [] },
          functions: {},
          hunks: [],
          impact: []
        };

        // Get detailed diff with line numbers
        const detailedDiff = await git.diff(['HEAD~1', 'HEAD', '--', file.file]);
        const lineChanges = this.parseGitDiff(detailedDiff);
        
        fileChange.lines = lineChanges.lines;
        fileChange.hunks = lineChanges.hunks;
        
        // AST analysis for function-level changes
        if (existsSync(file.file)) {
          const content = readFileSync(file.file, 'utf8');
          const ast = this.parseAST(content, file.file);
          fileChange.functions = await this.detectFunctionChanges(ast, lineChanges.lines);
          fileChange.impact = this.analyzeImpact(file.file, fileChange.functions);
        }
        
        changes.files[file.file] = fileChange;
        changes.summary.totalChanges++;
        
        if (file.insertions > 0 && file.deletions === 0) changes.summary.added++;
        else if (file.deletions > 0 && file.insertions === 0) changes.summary.deleted++;
        else changes.summary.modified++;
      }
    } catch (error) {
      console.error('Git analysis failed:', error);
      // Fallback to file system analysis
      return this.fallbackAnalysis();
    }

    // Save analysis results
    this.saveResults(changes);
    return changes;
  }

  parseGitDiff(diff) {
    const lines = { added: [], deleted: [], modified: [] };
    const hunks = [];
    const diffLines = diff.split('\n');
    
    let currentLine = 0;
    let hunk = null;
    
    for (const line of diffLines) {
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (match) {
          currentLine = parseInt(match[2]);
          hunk = { start: currentLine, content: [], type: 'mixed' };
          hunks.push(hunk);
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        lines.added.push(currentLine);
        if (hunk) hunk.content.push(line);
        currentLine++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        lines.deleted.push(currentLine);
        if (hunk) hunk.content.push(line);
      } else if (!line.startsWith('\\')) {
        currentLine++;
      }
    }
    
    // Identify modified lines (adjacent adds/deletes)
    for (let i = 0; i < lines.added.length; i++) {
      for (let j = 0; j < lines.deleted.length; j++) {
        if (Math.abs(lines.added[i] - lines.deleted[j]) <= 1) {
          lines.modified.push(lines.added[i]);
          lines.added.splice(i, 1);
          lines.deleted.splice(j, 1);
          i--;
          break;
        }
      }
    }
    
    hunks.forEach(h => h.end = h.start + h.content.length);
    
    return { lines, hunks };
  }

  parseAST(content, filename) {
    const ext = path.extname(filename);
    const plugins = [];
    
    if (ext === '.ts' || ext === '.tsx') plugins.push('typescript');
    if (ext === '.jsx' || ext === '.tsx') plugins.push('jsx');
    
    return parse(content, {
      sourceType: 'module',
      plugins: [...plugins, 'classProperties', 'decorators-legacy']
    });
  }

  async detectFunctionChanges(ast, lineChanges) {
    const functions = {};
    const allLines = [...lineChanges.added, ...lineChanges.modified, ...lineChanges.deleted];
    
    traverse.default(ast, {
      FunctionDeclaration(path) {
        const name = path.node.id?.name || 'anonymous';
        const start = path.node.loc.start.line;
        const end = path.node.loc.end.line;
        
        for (const line of allLines) {
          if (line >= start && line <= end) {
            functions[name] = lineChanges.deleted.some(l => l >= start && l <= end) ? 'deleted' :
                             lineChanges.added.some(l => l >= start && l <= end) ? 'added' : 'modified';
            break;
          }
        }
      },
      ArrowFunctionExpression(path) {
        if (path.parent.type === 'VariableDeclarator') {
          const name = path.parent.id?.name || 'anonymous';
          const start = path.node.loc.start.line;
          const end = path.node.loc.end.line;
          
          for (const line of allLines) {
            if (line >= start && line <= end) {
              functions[name] = lineChanges.deleted.some(l => l >= start && l <= end) ? 'deleted' :
                               lineChanges.added.some(l => l >= start && l <= end) ? 'added' : 'modified';
              break;
            }
          }
        }
      },
      ClassMethod(path) {
        const className = path.parent.parent.id?.name || 'Class';
        const methodName = path.node.key?.name || 'method';
        const name = `${className}.${methodName}`;
        const start = path.node.loc.start.line;
        const end = path.node.loc.end.line;
        
        for (const line of allLines) {
          if (line >= start && line <= end) {
            functions[name] = lineChanges.deleted.some(l => l >= start && l <= end) ? 'deleted' :
                             lineChanges.added.some(l => l >= start && l <= end) ? 'added' : 'modified';
            break;
          }
        }
      }
    });
    
    return functions;
  }

  analyzeImpact(file, functions) {
    const impacts = [];
    
    // UI component changes
    if (file.includes('components/') || file.includes('pages/')) {
      impacts.push('UI rendering');
      if (Object.keys(functions).some(f => f.includes('handle') || f.includes('on'))) {
        impacts.push('User interactions');
      }
    }
    
    // API changes
    if (file.includes('api/') || file.includes('services/')) {
      impacts.push('API endpoints');
      Object.keys(functions).forEach(f => {
        if (f.includes('get')) impacts.push('GET requests');
        if (f.includes('post')) impacts.push('POST requests');
        if (f.includes('put') || f.includes('update')) impacts.push('PUT requests');
        if (f.includes('delete')) impacts.push('DELETE requests');
      });
    }
    
    // State management
    if (file.includes('store/') || file.includes('redux/') || file.includes('context/')) {
      impacts.push('Application state');
    }
    
    // Routing
    if (file.includes('routes') || file.includes('router')) {
      impacts.push('Navigation');
    }
    
    return [...new Set(impacts)];
  }

  isTestableFile(filename) {
    const testableExtensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs'];
    const excludePaths = ['node_modules', 'dist', 'build', '.git', 'coverage'];
    
    return testableExtensions.some(ext => filename.endsWith(ext)) &&
           !excludePaths.some(path => filename.includes(path));
  }

  async fallbackAnalysis() {
    // Analyze without git history
    const files = await glob('source/**/*.{js,jsx,ts,tsx}', { ignore: '**/node_modules/**' });
    const changes = {
      files: {},
      summary: { added: 0, modified: 0, deleted: 0, totalChanges: files.length }
    };
    
    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf8');
        const ast = this.parseAST(content, file);
        const functions = {};
        
        traverse.default(ast, {
          FunctionDeclaration(path) {
            functions[path.node.id?.name || 'anonymous'] = 'unknown';
          },
          ArrowFunctionExpression(path) {
            if (path.parent.type === 'VariableDeclarator') {
              functions[path.parent.id?.name || 'anonymous'] = 'unknown';
            }
          },
          ClassMethod(path) {
            const className = path.parent.parent.id?.name || 'Class';
            const methodName = path.node.key?.name || 'method';
            functions[`${className}.${methodName}`] = 'unknown';
          }
        });
        
        changes.files[file] = {
          file,
          lines: { added: [], deleted: [], modified: [] },
          functions,
          hunks: [],
          impact: this.analyzeImpact(file, functions)
        };
        changes.summary.modified++;
      } catch (error) {
        console.error(`Failed to analyze ${file}:`, error.message);
      }
    }
    
    this.saveResults(changes);
    return changes;
  }

  saveResults(changes) {
    const outputPath = path.join(__dirname, '../test-results/change-analysis.json');
    writeFileSync(outputPath, JSON.stringify(changes, null, 2));
    
    // Create test targets
    const testTargets = {
      uiPaths: [],
      apiEndpoints: [],
      impactedAreas: [],
      specificFunctions: []
    };
    
    Object.entries(changes.files).forEach(([file, data]) => {
      if (file.includes('components/') || file.includes('pages/')) {
        testTargets.uiPaths.push(file);
      }
      if (file.includes('api/') || file.includes('services/')) {
        testTargets.apiEndpoints.push(file);
      }
      testTargets.impactedAreas.push(...data.impact);
      testTargets.specificFunctions.push(...Object.keys(data.functions));
    });
    
    // Remove duplicates
    Object.keys(testTargets).forEach(key => {
      testTargets[key] = [...new Set(testTargets[key])];
    });
    
    writeFileSync(
      path.join(__dirname, '../test-results/test-targets.json'),
      JSON.stringify(testTargets, null, 2)
    );
  }
}

// Execute analysis
const analyzer = new ChangeAnalyzer();
const changes = await analyzer.detectCodeChanges();

console.log(`Analysis complete: ${changes.summary.totalChanges} files analyzed`);
console.log(`- Added: ${changes.summary.added}`);
console.log(`- Modified: ${changes.summary.modified}`);
console.log(`- Deleted: ${changes.summary.deleted}`);

export { ChangeAnalyzer };
