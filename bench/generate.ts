/**
 * Synthetic Rule Designer workspace for benchmarks. Deterministic (seeded).
 *
 *   node --experimental-strip-types bench/generate.ts <out-dir> <artifact-count>
 *
 * Shape, per 1,000 artifacts: ~700 action rules, ~200 decision tables (half with
 * 50–200 rows), ~30 ruleflows, ~20 operations and variable sets, 20 packages over
 * two rule projects, and a BOM in `com.bench.*` packages with inheritance and
 * virtual (B2X) members. Rule bodies use the vocabulary the way real rules do,
 * through ruleset parameters, definitions variables and nested navigations.
 */
import fs from "node:fs";
import path from "node:path";

let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const WORDS = "account amount balance band category channel code count credit date debt deposit discount duration fee flag grade income interest limit margin months penalty premium price quota rate ratio region risk score segment status tenure term total value weight".split(" ");

export function generate(out: string, artifacts: number): { files: number } {
  fs.rmSync(out, { recursive: true, force: true });
  let files = 0;
  const write = (rel: string, text: string) => {
    const full = path.join(out, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    files++;
  };
  const scale = artifacts / 1000;
  const classCount = Math.max(10, Math.round(50 * Math.sqrt(scale)));
  const classes: { fqn: string; name: string; label: string; members: { name: string; label: string; type: string }[]; parent?: string }[] = [];
  for (let c = 0; c < classCount; c++) {
    const name = `Entity${c}`;
    const pkg = `com.bench.domain${c % 5}`;
    const members: { name: string; label: string; type: string }[] = [];
    const used = new Set<string>();
    for (let m = 0; m < 10; m++) {
      let a = pick(WORDS);
      let b = pick(WORDS);
      while (used.has(`${a} ${b}`) || a === b) {
        a = pick(WORDS);
        b = pick(WORDS);
      }
      used.add(`${a} ${b}`);
      members.push({ name: `${a}${b[0].toUpperCase()}${b.slice(1)}`, label: `${a} ${b}`, type: m % 4 === 3 ? "string" : "double" });
    }
    classes.push({ fqn: `${pkg}.${name}`, name, label: `entity ${c}`, members, parent: c > 4 && c % 3 === 0 ? classes[c % 5].fqn : undefined });
  }
  const params = classes.slice(0, Math.min(8, classes.length)).map((klass, i) => ({ name: `p${i}`, verbal: `the ${klass.label}`, type: klass.fqn, klass }));

  // BOM project
  write("BenchBOM/.ruleproject", ruleproject("BenchBOM", false, []));
  write("BenchBOM/.project", eclipse("BenchBOM", []));
  const byPackage = new Map<string, typeof classes>();
  for (const klass of classes) {
    const pkg = klass.fqn.slice(0, klass.fqn.lastIndexOf("."));
    byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), klass]);
  }
  let bom = `property origin "xom:/BenchBOM/bench-xom"\nproperty uuid "bench-bom"\n`;
  for (const [pkg, list] of byPackage) {
    bom += `package ${pkg};\n\n`;
    for (const klass of list) {
      bom += `public class ${klass.name}${klass.parent ? ` extends ${klass.parent}` : ""}\n{\n`;
      for (const member of klass.members) bom += `    public ${member.type} ${member.name};\n`;
      bom += `    public readonly double derivedRatio;\n    public void flag(string reason);\n}\n\n`;
    }
  }
  write("BenchBOM/bom/model.bom", bom);
  let voc = "uuid = bench-voc\n";
  let b2x = `<?xml version="1.0" encoding="UTF-8"?>\n<b2x:javaXOMMapping xmlns:b2x="http://schemas.ilog.com/JRules/1.1/B2X">\n`;
  for (const klass of classes) {
    voc += `${klass.fqn}#concept.label = ${klass.label}\n`;
    for (const member of klass.members) {
      voc += `${klass.fqn}.${member.name}#phrase.navigation = {${member.label}} of {this}\n`;
      voc += `${klass.fqn}.${member.name}#phrase.action = set the ${member.label} of {this} to {${member.label}}\n`;
    }
    voc += `${klass.fqn}.derivedRatio#phrase.navigation = {derived ratio} of {this}\n`;
    voc += `${klass.fqn}.flag(java.lang.String)#phrase.action = flag {this} with {0}\n`;
    b2x += `  <class><businessName>${klass.fqn}</businessName><executionName>${klass.fqn}</executionName>\n    <attribute><name>derivedRatio</name><getter language="irl"><![CDATA[return this.${klass.members[0].name} / this.${klass.members[1].name};]]></getter></attribute>\n  </class>\n`;
  }
  write("BenchBOM/bom/model_en_US.voc", voc);
  write("BenchBOM/bom/model.b2x", `${b2x}</b2x:javaXOMMapping>\n`);

  // Rule projects
  const packageCount = Math.max(4, Math.round(20 * scale));
  const packages = Array.from({ length: packageCount }, (_, i) => `area${i % 7}.group${i}`);
  const rulesTarget = Math.round(700 * scale);
  const tablesTarget = Math.round(200 * scale);
  const flowsTarget = Math.max(1, Math.round(30 * scale));
  const opsTarget = Math.max(1, Math.round(20 * scale));
  const project = (i: number) => (i % 2 === 0 ? "BenchRulesA" : "BenchRulesB");
  for (const name of ["BenchRulesA", "BenchRulesB"]) {
    write(`${name}/.ruleproject`, ruleproject(name, false, ["BenchBOM"]));
    write(`${name}/.project`, eclipse(name, ["BenchBOM"]));
  }
  packages.forEach((pkg, i) => write(`${project(i)}/rules/${pkg.replace(/\./g, "/")}/.rulepackage`, rulePackage(pkg.split(".").pop() as string, `pkg-${i}`)));

  const nav = (param: (typeof params)[number]) => {
    const member = pick(param.klass.members);
    return { text: `the ${member.label} of '${param.verbal}'`, member };
  };
  for (let r = 0; r < rulesTarget; r++) {
    const pkgIndex = r % packageCount;
    const param = pick(params);
    const other = pick(params);
    const a = nav(param);
    const b = nav(other);
    const useDefinition = r % 5 === 0;
    const bal = [
      ...(useDefinition ? ["definitions", `    set 'the subject' to ${param.verbal.replace(/^the /, "a ")} ;`] : []),
      "if",
      `    ${useDefinition ? a.text.replace(`'${param.verbal}'`, "'the subject'") : a.text} is more than ${int(1, 1000)}`,
      `    and ${b.member.type === "string" ? `${b.text} is "${pick(WORDS)}"` : `${b.text} is at least ${int(1, 100)}`}`,
      "then",
      `    flag '${param.verbal}' with "rule ${r}" ;`,
      `    set ${a.text.replace(/^the /, "the ")} to ${int(1, 9)} ;`,
    ].join("\n");
    const name = `${pick(WORDS)} ${pick(WORDS)} check ${r}`;
    write(`${project(pkgIndex)}/rules/${packages[pkgIndex].replace(/\./g, "/")}/${name}.brl`, actionRule(name, `brl-${r}`, bal));
  }
  for (let t = 0; t < tablesTarget; t++) {
    const pkgIndex = t % packageCount;
    const param = pick(params);
    const c0 = pick(param.klass.members.filter((member) => member.type === "double"));
    const c1 = pick(param.klass.members.filter((member) => member.type === "double" && member !== c0)) ?? c0;
    const rows = t % 2 === 0 ? int(50, 200) : int(3, 12);
    const name = `${pick(WORDS)} table ${t}`;
    write(
      `${project(pkgIndex)}/rules/${packages[pkgIndex].replace(/\./g, "/")}/${name}.dta`,
      decisionTable(name, `dta-${t}`, `the ${c0.label} of '${param.verbal}'`, `the ${c1.label} of '${param.verbal}'`, `flag '${param.verbal}' with <a string>`, rows),
    );
  }
  // Decision service project: ruleflows, variable set, operations
  write("BenchDS/.ruleproject", ruleproject("BenchDS", true, ["BenchRulesA", "BenchRulesB", "BenchBOM"]));
  write("BenchDS/.project", eclipse("BenchDS", ["BenchRulesA", "BenchRulesB", "BenchBOM"]));
  write("BenchDS/rules/parameters.var", variableSet(params));
  for (let f = 0; f < flowsTarget; f++) {
    const selected = packages.filter((_, i) => i % flowsTarget === f || (f === 0 && i % 3 === 0));
    write(`BenchDS/rules/flows/flow ${f}.rfl`, ruleflow(`flow ${f}`, `rfl-${f}`, selected.length ? selected : [packages[0]]));
  }
  for (let o = 0; o < opsTarget; o++) {
    write(`BenchDS/deployment/operation ${o}.dop`, operation(`operation ${o}`, `op-${o}`, `flow ${o % flowsTarget}`, `rfl-${o % flowsTarget}`, params));
  }
  for (let v = 1; v < opsTarget; v++) write(`BenchDS/rules/vars/extra ${v}.var`, variableSet([], `extra ${v}`, `var-${v}`));
  return { files };
}

function ruleproject(name: string, ds: boolean, _refs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ilog.rules.studio.model.base:RuleProject xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ilog.rules.studio.model.base="http://ilog.rules.studio/model/base.ecore" xmlns:ilog.rules.studio.model.bom="http://ilog.rules.studio/model/bom.ecore" isADecisionService="${ds}">
  <name>${name}</name>
  <uuid>${name}-uuid</uuid>
  <modelFolders xsi:type="ilog.rules.studio.model.base:SourceFolder"><name>rules</name></modelFolders>
  <modelFolders xsi:type="ilog.rules.studio.model.bom:BOMFolder"><name>bom</name></modelFolders>
</ilog.rules.studio.model.base:RuleProject>
`;
}
function eclipse(name: string, refs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<projectDescription><name>${name}</name><projects>${refs.map((ref) => `<project>${ref}</project>`).join("")}</projects></projectDescription>\n`;
}
function rulePackage(name: string, uuid: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ilog.rules.studio.model.base:RulePackage xmlns:ilog.rules.studio.model.base="http://ilog.rules.studio/model/base.ecore"><name>${name}</name><uuid>${uuid}</uuid></ilog.rules.studio.model.base:RulePackage>\n`;
}
function actionRule(name: string, uuid: string, bal: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ilog.rules.studio.model.brl:ActionRule xmlns:ilog.rules.studio.model.brl="http://ilog.rules.studio/model/brl.ecore">\n  <name>${name}</name>\n  <uuid>${uuid}</uuid>\n  <locale>en_US</locale>\n  <definition><![CDATA[${bal}]]></definition>\n</ilog.rules.studio.model.brl:ActionRule>\n`;
}
function decisionTable(name: string, uuid: string, c0: string, c1: string, action: string, rows: number): string {
  let contents = "";
  const outer = Math.max(1, Math.round(Math.sqrt(rows)));
  const inner = Math.max(1, Math.ceil(rows / outer));
  let made = 0;
  for (let i = 0; i < outer && made < rows; i++) {
    contents += `<Condition><Expression><Param><![CDATA[${i * 10}]]></Param><Param><![CDATA[${i * 10 + 10}]]></Param></Expression><Partition DefId="C1">`;
    for (let j = 0; j < inner && made < rows; j++, made++) {
      contents += `<Condition><Expression><Param><![CDATA[${j}]]></Param><Param><![CDATA[${j + 1}]]></Param></Expression><ActionSet><Action DefId="A0"><Expression><Param><![CDATA["band ${i}-${j}"]]></Param></Expression></Action></ActionSet></Condition>`;
    }
    contents += `</Partition></Condition>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<model.dt:DecisionTable xmlns:model.dt="http://ilog.rules.studio/model/dt.ecore">
  <name>${name}</name>
  <uuid>${uuid}</uuid>
  <locale>en_US</locale>
  <definition><DT xmlns="http://schemas.ilog.com/Rules/7.0/DecisionTable" Version="7.0"><Body><Structure>
    <ConditionDefinitions>
      <ConditionDefinition Id="C0"><ExpressionDefinition><Text><![CDATA[${c0} is at least <min> and less than <max>]]></Text></ExpressionDefinition></ConditionDefinition>
      <ConditionDefinition Id="C1"><ExpressionDefinition><Text><![CDATA[${c1} is at least <min> and less than <max>]]></Text></ExpressionDefinition></ConditionDefinition>
    </ConditionDefinitions>
    <ActionDefinitions><ActionDefinition Id="A0"><ExpressionDefinition><Text><![CDATA[${action}]]></Text></ExpressionDefinition></ActionDefinition></ActionDefinitions>
  </Structure><Contents><Partition DefId="C0">${contents}</Partition></Contents></Body></DT></definition>
</model.dt:DecisionTable>
`;
}
function ruleflow(name: string, uuid: string, packages: string[]): string {
  const tasks = packages.map((pkg, i) => `<RuleTask ExecutionMode="Fastpath" Identifier="t${i}"><RuleList><Package Name="${pkg}"/></RuleList></RuleTask>`).join("");
  const nodes = ["start", ...packages.map((_, i) => `t${i}`), "end"].map((task, i) => `<TaskNode Identifier="n${i}" Task="${task}"/>`).join("");
  const transitions = ["start", ...packages.map((_, i) => `t${i}`), "end"]
    .slice(0, -1)
    .map((_, i) => `<Transition Identifier="x${i}" Source="n${i}" Target="n${i + 1}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ilog.rules.studio.model.ruleflow:RuleFlow xmlns:ilog.rules.studio.model.ruleflow="http://ilog.rules.studio/model/ruleflow.ecore">
  <name>${name}</name><uuid>${uuid}</uuid><locale>en_US</locale>
  <rfModel><Ruleflow xmlns="http://schemas.ilog.com/Rules/7.0/Ruleflow"><Body><TaskList><StartTask Identifier="start"/>${tasks}<StopTask Identifier="end"/></TaskList><NodeList>${nodes}</NodeList><TransitionList>${transitions}</TransitionList></Body></Ruleflow></rfModel>
</ilog.rules.studio.model.ruleflow:RuleFlow>
`;
}
function operation(name: string, uuid: string, flowName: string, flowUuid: string, params: { name: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<com.ibm.rules.studio.model.decisionservice:Operation xmlns:com.ibm.rules.studio.model.decisionservice="http://com.ibm.rules.studio/model/decisionservice.ecore" rulesetName="${name.replace(/ /g, "_")}" usingRuleflow="true" ruleflowName="${flowName}">
  <name>${name}</name><uuid>${uuid}</uuid>
  ${params.map((param) => `<referencedVariables variableName="${param.name}" variableSetName="parameters.var"/>`).join("\n  ")}
  <ruleflow href="../rules/flows/${flowName}.rfl#${flowUuid}"/>
</com.ibm.rules.studio.model.decisionservice:Operation>
`;
}
function variableSet(params: { name: string; verbal: string; type: string }[], name = "parameters", uuid = "var-0"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ilog.rules.studio.model.base:VariableSet xmlns:ilog.rules.studio.model.base="http://ilog.rules.studio/model/base.ecore">
  <name>${name}</name><uuid>${uuid}</uuid>
  ${params.map((param) => `<variables name="${param.name}" type="${param.type}" verbalization="${param.verbal}"/>`).join("\n  ")}
</ilog.rules.studio.model.base:VariableSet>
`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("generate.ts")) {
  const [out, count] = process.argv.slice(2);
  if (out && count) console.log(generate(path.resolve(out), Number(count)));
}
