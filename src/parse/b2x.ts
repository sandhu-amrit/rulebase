/**
 * Parser for `.b2x` files: the BOM-to-XOM mapping that implements virtual
 * classes and members.
 *
 *   <b2x:javaXOMMapping xmlns:b2x="http://schemas.ilog.com/JRules/1.1/B2X">
 *     <class>
 *       <businessName>com.acme.loan.Borrower</businessName>
 *       <executionName>com.acme.xom.Customer</executionName>
 *       <attribute>
 *         <name>debtRatio</name>
 *         <getter language="irl"><![CDATA[ return this.yearlyRepayment / this.yearlyIncome; ]]></getter>
 *       </attribute>
 *       <method>
 *         <name>isEligible</name>
 *         <parameter type="int"/>
 *         <body language="irl"><![CDATA[ return creditScore > arg; ]]></body>
 *       </method>
 *     </class>
 *   </b2x:javaXOMMapping>
 *
 * Elements are matched by local name, so namespace prefixes don't matter.
 * Unknown elements are reported as info. Nothing is dropped silently.
 */
import type { Provenance, Warning } from "../model.ts";
import { asArray, child, children, rootElement, textOf, attr, parseXml } from "./xml.ts";

export interface B2xMember {
  name: string;
  kind: "attribute" | "method" | "constructor";
  paramTypes: string[];
  /** getter / setter / body text, labelled. */
  implementation: string;
}

export interface B2xClass {
  businessName: string;
  executionName?: string;
  members: B2xMember[];
  /** Class-level code (e.g. `<import>` or tester). */
  extra?: string;
}

export interface ParsedB2x {
  classes: B2xClass[];
  provenance: Provenance;
  warnings: Warning[];
}

const KNOWN_CLASS_CHILDREN = new Set(["businessName", "executionName", "attribute", "method", "constructor", "import", "tester", "extender"]);

export function parseB2x(content: string, provenance: Provenance): ParsedB2x {
  const warnings: Warning[] = [];
  const classes: B2xClass[] = [];
  let doc: unknown;
  try {
    doc = parseXml(content);
  } catch (error) {
    warnings.push({ path: provenance.path, severity: "error", message: `B2X is not well-formed XML: ${errorText(error)}` });
    return { classes, provenance, warnings };
  }
  const root = rootElement(doc);
  if (!root) {
    warnings.push({ path: provenance.path, severity: "error", message: "B2X has no root element" });
    return { classes, provenance, warnings };
  }
  for (const node of children(root.node, "class")) {
    const businessName = textOf(child(node, "businessName")).trim();
    if (!businessName) {
      warnings.push({ path: provenance.path, severity: "error", message: "B2X <class> without <businessName>" });
      continue;
    }
    const klass: B2xClass = {
      businessName,
      executionName: textOf(child(node, "executionName")).trim() || undefined,
      members: [],
    };
    for (const kind of ["attribute", "method", "constructor"] as const) {
      for (const memberNode of children(node, kind)) {
        const name = textOf(child(memberNode, "name")).trim() || (kind === "constructor" ? businessName.split(".").pop() ?? "" : "");
        const paramTypes = children(memberNode, "parameter").map((param) => attr(param, "type") ?? textOf(param).trim());
        const parts: string[] = [];
        for (const label of ["getter", "setter", "body"]) {
          const text = textOf(child(memberNode, label)).trim();
          if (text) parts.push(`${label}: ${text}`);
        }
        klass.members.push({ name, kind, paramTypes, implementation: parts.join("\n") });
      }
    }
    const extra = ["import", "tester", "extender"]
      .map((label) => textOf(child(node, label)).trim())
      .filter(Boolean)
      .join("\n");
    if (extra) klass.extra = extra;
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const local = key.startsWith("@") || key.startsWith("#") ? null : key.slice(key.lastIndexOf(":") + 1);
      if (local && !KNOWN_CLASS_CHILDREN.has(local)) {
        warnings.push({ path: provenance.path, severity: "info", message: `B2X <${local}> in ${businessName} is not interpreted` });
      }
    }
    classes.push(klass);
  }
  if (!classes.length) {
    warnings.push({ path: provenance.path, severity: "info", message: "B2X file maps no classes" });
  }
  return { classes, provenance, warnings };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { asArray };
