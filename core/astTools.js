// core/astTools.js
'use strict';

const { parseLuaArrayElements, resolveLuaStringEscapes, stripLuaString,
         splitByComma, splitByConcat, scoreLuaCode,
         cacheGet, cacheSet, cacheHash } = require('../utils/luaPrinter');
const { evalLuaNumExpr, evalSimpleExpr, evalStringChar,
         evalArithWithEnv, evalExprWithEnv,
         deobfuscateSplitStrings, charDecoder, xorDecoder, deobfuscateXOR,
         staticCharDecoder, stringTransformDecoder, base64Detector,
         deobfuscateEncryptStrings, decodeEscapedString,
         decodeAllEscapedStrings, decodeStringBuilder,
         CapturePool, SymbolicEnv } = require('./stringDecoder');


// ────────────────────────────────────────────────────────────────────────
//  共通ユーティリティ  (v2から引継ぎ + 拡張)
// ────────────────────────────────────────────────────────────────────────
function evaluateExpressions(code) {
  let modified = code, found = false;
  let prev, iters = 0;
  do {
    prev = modified;
    modified = modified.replace(/\(\s*([\d.]+)\s*([\+\-\*\/\%])\s*([\d.]+)\s*\)/g, (_, a, op, b) => {
      const result = evalSimpleExpr(`${a}${op}${b}`);
      if (result === null) return _;
      found = true; return String(result);
    });
  } while (modified !== prev && ++iters < 20);
  modified = modified.replace(/\[\s*([\d\s+\-*\/%().]+)\s*\]/g, (match, expr) => {
    const result = evalSimpleExpr(expr);
    if (result === null) return match;
    found = true; return `[${result}]`;
  });
  let concatIter = 0;
  while (/"((?:[^"\\]|\\.)*)"\s*\.\.\s*"((?:[^"\\]|\\.)*)"/g.test(modified) && concatIter++ < 40) {
    modified = modified.replace(/"((?:[^"\\]|\\.)*)"\s*\.\.\s*"((?:[^"\\]|\\.)*)"/g, (_, a, b) => { found = true; return `"${a}${b}"`; });
  }
  if (!found) return { success: false, error: '評価できる式がありませんでした', method: 'eval_expressions' };
  return { success: true, result: modified, method: 'eval_expressions' };
}

// ────────────────────────────────────────────────────────────────────────
//  #3  splitStrings  — 連続文字列連結を1つにまとめる
// ────────────────────────────────────────────────────────────────────────
function constantArrayResolver(code, env) {
  env=env||new SymbolicEnv();
  let modified=code, found=false;
  let passCount=0;
  while(passCount++<12){
    let changed=false;
    const arrayPattern=/local\s+(\w+)\s*=\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    let match; const snapshot=modified;
    while((match=arrayPattern.exec(snapshot))!==null){
      const varName=match[1],content=match[2];
      const elements=parseLuaArrayElements(content);
      if(elements.length<1) continue;
      const values=elements.map(e=>{
        const n=evalLuaNumExpr(e.trim()); if(n!==null) return n;
        const s=stripLuaString(e.trim()); if(s!==null) return s;
        return null;
      });
      if(values.some(v=>v===null)) continue;
      env.set(varName,{type:'table',value:values});
      const esc=varName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const indexRe=new RegExp(esc+'\\[([^\\]]+)\\]','g');
      modified=modified.replace(indexRe,(fullMatch,indexExpr)=>{
        const idx=evalExprWithEnv(indexExpr,env);
        if(idx===null||typeof idx!=='number') return fullMatch;
        const rounded=Math.round(idx);
        if(rounded<1||rounded>values.length) return fullMatch;
        found=true; changed=true;
        const v=values[rounded-1];
        if(typeof v==='string') return `"${v.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
        return String(v);
      });
    }
    if(!changed) break;
  }
  if(!found) return { success:false, error:'ConstantArrayパターンが見つかりません', method:'constant_array' };
  return { success:true, result:modified, method:'constant_array' };
}
// 後方互換
function deobfuscateConstantArray(code){ return constantArrayResolver(code); }

// ────────────────────────────────────────────────────────────────────────
//  #7  constantCallEvaluator  — tonumber/tostring の定数呼び出しを変換
// ────────────────────────────────────────────────────────────────────────
function constantCallEvaluator(code) {
  let modified=code, found=false;
  // tonumber("123") -> 123, tonumber("0xff") -> 255
  modified=modified.replace(/\btonumber\s*\(\s*"([^"]+)"\s*(?:,\s*(\d+))?\s*\)/g,(_,s,base)=>{
    const n=parseInt(s,base?parseInt(base):10);
    if(isNaN(n)) return _;
    found=true; return String(n);
  });
  modified=modified.replace(/\btonumber\s*\(\s*'([^']+)'\s*(?:,\s*(\d+))?\s*\)/g,(_,s,base)=>{
    const n=parseInt(s,base?parseInt(base):10);
    if(isNaN(n)) return _;
    found=true; return String(n);
  });
  // tostring(123) -> "123"
  modified=modified.replace(/\btostring\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/g,(_,n)=>{
    found=true; return `"${n}"`;
  });
  if(!found) return { success:false, error:'tonumber/tostringの定数呼び出しが見つかりません', method:'constant_call' };
  return { success:true, result:modified, method:'constant_call' };
}

// ────────────────────────────────────────────────────────────────────────
//  #8  mathEvaluator  — math.* の引数が定数なら結果に置換
// ────────────────────────────────────────────────────────────────────────
function mathEvaluator(code) {
  let modified=code, found=false;
  const fns=['floor','ceil','abs','sqrt','max','min'];
  for(const fn of fns){
    const re=new RegExp(`math\\.${fn}\\s*\\(([^)]+)\\)`,'g');
    modified=modified.replace(re,(match,args)=>{
      const argList=splitByComma(args).map(a=>evalLuaNumExpr(a.trim()));
      if(argList.some(v=>v===null)) return match;
      let result;
      if(fn==='floor') result=Math.floor(argList[0]);
      else if(fn==='ceil') result=Math.ceil(argList[0]);
      else if(fn==='abs') result=Math.abs(argList[0]);
      else if(fn==='sqrt') result=Math.sqrt(argList[0]);
      else if(fn==='max') result=Math.max(...argList);
      else if(fn==='min') result=Math.min(...argList);
      if(result===undefined||!isFinite(result)) return match;
      found=true;
      return Number.isInteger(result)?String(result):result.toFixed(6);
    });
  }
  if(!found) return { success:false, error:'math.*の定数呼び出しが見つかりません', method:'math_eval' };
  return { success:true, result:modified, method:'math_eval' };
}

// ────────────────────────────────────────────────────────────────────────
//  #9  deadBranchRemover  — if true/false の不要分岐を削除
// ────────────────────────────────────────────────────────────────────────
function deadBranchRemover(code) {
  let modified=code, found=false;
  // if true then ... end  → 中身だけ残す
  modified=modified.replace(/\bif\s+true\s+then\s+([\s\S]*?)\s*end\b/g,(_,body)=>{ found=true; return body.trim(); });
  // if false then ... end  → 完全削除
  modified=modified.replace(/\bif\s+false\s+then\s+[\s\S]*?\s*end\b/g,()=>{ found=true; return ''; });
  // if true then ... else ... end → then節だけ残す
  modified=modified.replace(/\bif\s+true\s+then\s+([\s\S]*?)\s*else\s+[\s\S]*?\s*end\b/g,(_,thenPart)=>{ found=true; return thenPart.trim(); });
  // if false then ... else ... end → else節だけ残す
  modified=modified.replace(/\bif\s+false\s+then\s+[\s\S]*?\s*else\s+([\s\S]*?)\s*end\b/g,(_,elsePart)=>{ found=true; return elsePart.trim(); });
  // while false do ... end → 削除
  modified=modified.replace(/\bwhile\s+false\s+do\s+[\s\S]*?\s*end\b/g,()=>{ found=true; return ''; });
  // repeat ... until true → 1回実行（内容だけ残す）
  modified=modified.replace(/\brepeat\s+([\s\S]*?)\s*until\s+true\b/g,(_,body)=>{ found=true; return body.trim(); });
  if(!found) return { success:false, error:'デッドブランチが見つかりません', method:'dead_branch' };
  return { success:true, result:modified, method:'dead_branch' };
}

// ────────────────────────────────────────────────────────────────────────
//  #10  junkAssignmentCleaner  — 無意味代入・自己代入を削除
// ────────────────────────────────────────────────────────────────────────
function junkAssignmentCleaner(code) {
  let modified=code, found=false;
  // local a = a  (自己代入)
  modified=modified.replace(/local\s+(\w+)\s*=\s*\1\s*[\n;]/g,(_,name)=>{ found=true; return ''; });
  // local _ = ... (アンダースコア変数への代入)
  modified=modified.replace(/local\s+_\s*=\s*[^\n;]+[\n;]/g,()=>{ found=true; return ''; });
  // 連続する空行を1行に圧縮
  modified=modified.replace(/\n{3,}/g,'\n\n');
  if(!found) return { success:false, error:'ジャンク代入が見つかりません', method:'junk_clean' };
  return { success:true, result:modified, method:'junk_clean' };
}

// ────────────────────────────────────────────────────────────────────────
//  #11  duplicateConstantReducer  — 重複定数を1つにまとめる
// ────────────────────────────────────────────────────────────────────────
function duplicateConstantReducer(code) {
  let modified=code, found=false;
  // 同じ string.char(...) が3回以上出現する場合に変数化
  const scMap=new Map();
  modified.replace(/string\.char\([^)]+\)/g,m=>{ scMap.set(m,(scMap.get(m)||0)+1); });
  for(const [expr,count] of scMap) {
    if(count<3) continue;
    const varName=`_sc${Math.abs(hashCode(expr)&0xffff).toString(16)}`;
    // 変数宣言を先頭に追加し、使用箇所を置換
    const escapedExpr=expr.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp(escapedExpr,'g');
    if(re.test(modified)){
      modified=`local ${varName}=${expr}\n`+modified.replace(re,varName);
      found=true;
    }
  }
  if(!found) return { success:false, error:'重複定数が見つかりません', method:'dup_reduce' };
  return { success:true, result:modified, method:'dup_reduce' };
}

// ────────────────────────────────────────────────────────────────────────
//  #12  sandboxFilter  — 危険関数除去 + サイズ制限
// ────────────────────────────────────────────────────────────────────────
function advancedStaticDeobfuscate(code) {
  const pool=new CapturePool();
  const { code:result, steps } = recursiveDeobfuscate(code, 8, pool);
  const changed=result!==code;
  return {
    success: changed,
    result,
    steps: steps.map(s=>s.step),
    method: 'advanced_static',
    error: changed?undefined:'静的解析で変化なし（動的実行が必要な可能性があります）',
  };
}

// deepStaticDeobfuscate (後方互換)
function deepStaticDeobfuscate(code, maxDepth) {
  const { code:result, steps } = recursiveDeobfuscate(code, maxDepth||6, new CapturePool());
  return { code:result, changed:result!==code };
}

// symbolicExecute, SymbolicEnv (後方互換エクスポート用スタブ)
function symbolicExecute(code, env, depth, visited) {
  const res=recursiveDeobfuscate(code, 2, new CapturePool());
  return { code:res.code, env:env||new SymbolicEnv(), changed:res.code!==code };
}





// ════════════════════════════════════════════════════════
//  AUTO  — v3 解析パイプライン
//
//  処理順 (#1要件):
//   1. advanced_static (ConstantFolding / SymExec / 全静的パス)
//   2. evaluate_expressions
//   3. split_strings
//   4. xor
//   5. constant_array
//   6. dynamic (Lua実行 → 多段ループ)
//   7. vmify (VM検出ヒント)
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════
//  autoDeobfuscate  v4  — 全10項目対応パイプライン
//
//  処理順:
//   ① dynamicDecode (loadstring hook, safeEnv, __DECODED__ dump) ← #1/#2 最初に配置
//   ② loaderPatternDetected チェック → true なら VM解析スキップ   ← #7/#8
//   ③ 静的解析群 (advanced_static, eval, split, xor, constantArray)
//   ④ VM検出 → dynamicDecode結果に対してのみ実行                  ← #1/#5
//   ⑤ VM解析 (vmTraceAnalyzer, reconstructedLuaBuilder)
//   ⑥ #10: decode結果がLuaコードなら再帰パイプライン実行
// ════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════
function recursiveDeobfuscate(code, maxDepth, pool) {
  maxDepth=maxDepth||8;
  pool=pool||new CapturePool();
  const seenHashes=new Set();

  // 静的パスのリスト（処理順: #1の要件に対応）
  const staticPasses=[
    { name:'ConstantFolding',    fn: c=>evaluateExpressions(c) },
    { name:'EvalExpressions',    fn: c=>evaluateExpressions(c) },
    { name:'SplitStrings',       fn: c=>deobfuscateSplitStrings(c) },
    { name:'XOR',                fn: c=>xorDecoder(c) },
    { name:'ConstantArray',      fn: c=>constantArrayResolver(c) },
    { name:'CharDecoder',        fn: c=>charDecoder(c) },
    { name:'MathEval',           fn: c=>mathEvaluator(c) },
    { name:'ConstantCall',       fn: c=>constantCallEvaluator(c) },
    { name:'StringTransform',    fn: c=>stringTransformDecoder(c) },
    { name:'DeadBranch',         fn: c=>deadBranchRemover(c) },
    { name:'JunkClean',          fn: c=>junkAssignmentCleaner(c) },
  ];

  let current=code;
  let depth=0;
  const allSteps=[];

  while(depth++<maxDepth){
    const h=cacheHash(current);
    if(seenHashes.has(h)) break;
    seenHashes.add(h);

    // キャッシュチェック
    const cached=cacheGet(current);
    if(cached){ current=cached; allSteps.push({step:'CacheHit',success:true,method:'cache'}); break; }

    let anyChange=false;
    for(const pass of staticPasses){
      const res=pass.fn(current);
      if(res.success&&res.result&&res.result!==current){
        allSteps.push({ step:pass.name, success:true, method:res.method });
        pool.add(res.result, pass.name);
        current=res.result;
        anyChange=true;
      }
    }

    // base64チェック
    base64Detector(current, pool);

    if(!anyChange) break;
  }

  // キャッシュに保存
  if(current!==code) cacheSet(code, current);

  return { code:current, steps:allSteps, pool };
}

// ════════════════════════════════════════════════════════════════════════
//  advancedStaticDeobfuscate  — 全パス統合エントリーポイント
// ════════════════════════════════════════════════════════════════════════

module.exports = {
  CapturePool, SymbolicEnv,
  evaluateExpressions, constantArrayResolver, deobfuscateConstantArray,
  constantCallEvaluator, mathEvaluator, deadBranchRemover,
  junkAssignmentCleaner, duplicateConstantReducer,
  advancedStaticDeobfuscate, deepStaticDeobfuscate, symbolicExecute,
  recursiveDeobfuscate,
};
