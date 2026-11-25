import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBom, typeCategory } from "../src/parse/bom.ts";

const prov = { project: "P", path: "bom/x.bom" };

test("fully qualified classes, inheritance, interfaces and modifiers", () => {
  const bom = parseBom(
    `property origin "xom:/P/xom"
package com.acme.loan;

public abstract class Party
{
    public readonly string name;
}

public class Borrower extends com.acme.loan.Party implements com.acme.Scored, com.acme.Named
        property "ilog.rules.business_documentation" "A person"
{
    public int creditScore;
}

public interface Scored
{
    public int score();
}
`,
    prov,
    "x",
  );
  assert.deepEqual(bom.warnings, []);
  assert.equal(bom.properties.origin, "xom:/P/xom");
  assert.deepEqual(bom.classes.map((klass) => klass.fqn), ["com.acme.loan.Party", "com.acme.loan.Borrower", "com.acme.loan.Scored"]);
  const borrower = bom.classes[1];
  assert.deepEqual(borrower.superTypes, ["com.acme.loan.Party", "com.acme.Scored", "com.acme.Named"]);
  assert.equal(borrower.documentation, "A person");
  assert.deepEqual(bom.classes[0].modifiers, ["public", "abstract"]);
  assert.equal(bom.classes[2].kind, "interface");
  assert.equal(bom.members.find((member) => member.name === "score")?.kind, "method");
});

test("members: types, statics, domains, methods, constructors, properties", () => {
  const bom = parseBom(
    `package a.b;
public final class Grade
        domain {static GOLD, static SILVER}
{
    public static final readonly a.b.Grade GOLD;
    public static final readonly a.b.Grade SILVER;
}
public class Loan
{
    public readonly java.util.Collection messages domain 0,* class string;
    public java.util.List<a.b.Grade> grades;
    public int[] scores;
    public string domain;
    public Loan(int amount, double rate)
                property "ilog.rules.engine.dataio.forConversion" "true";
    public static int max(int a, int b);
    public void addToMessages(string arg);
    /* a comment with ; and { inside */
    // another one; }
    public boolean approved
                property "factory.ignore" "true";
}
`,
    prov,
    "x",
  );
  assert.deepEqual(bom.warnings, []);
  const grade = bom.classes.find((klass) => klass.name === "Grade");
  assert.deepEqual(grade?.domain, ["GOLD", "SILVER"]);
  const byName = Object.fromEntries(bom.members.map((member) => [member.name, member]));
  assert.equal(byName.GOLD.static, true);
  assert.equal(byName.GOLD.final, true);
  assert.equal(byName.GOLD.type, "a.b.Grade");
  assert.equal(byName.messages.domain, "0,* class string");
  assert.equal(byName.messages.readonly, true);
  assert.equal(byName.grades.type, "java.util.List<a.b.Grade>");
  assert.equal(byName.scores.type, "int[]");
  assert.equal(byName.domain.type, "string", "a member named 'domain' is a member, not a domain clause");
  assert.equal(byName.Loan.kind, "constructor");
  assert.equal(byName.Loan.id, "a.b.Loan.Loan(int,double)");
  assert.equal(byName.max.static, true);
  assert.equal(byName.max.id, "a.b.Loan.max(int,int)");
  assert.equal(byName.approved.properties["factory.ignore"], "true");
});

test("unreadable statements are reported with a line number, not dropped", () => {
  const bom = parseBom(
    `package a;
public class X
{
    public int ok;
    this is not a member;
}
`,
    prov,
    "x",
  );
  assert.equal(bom.members.length, 1);
  assert.equal(bom.warnings.length, 1);
  assert.match(bom.warnings[0].message, /line 5: could not read member of a\.X/);
  assert.equal(bom.warnings[0].severity, "error");
});

test("type categories", () => {
  assert.equal(typeCategory("int"), "number");
  assert.equal(typeCategory("java.math.BigDecimal"), "number");
  assert.equal(typeCategory("string"), "string");
  assert.equal(typeCategory("boolean"), "boolean");
  assert.equal(typeCategory("java.util.Date"), "date");
  assert.equal(typeCategory("java.util.Collection"), "collection");
  assert.equal(typeCategory("com.acme.Loan"), "object");
});
