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
  assert.deepEqual(
    bom.classes.map((klass) => klass.fqn),
    ["com.acme.loan.Party", "com.acme.loan.Borrower", "com.acme.loan.Scored"],
  );
  const borrower = bom.classes[1];
  assert.deepEqual(borrower.superTypes, [
    "com.acme.loan.Party",
    "com.acme.Scored",
    "com.acme.Named",
  ]);
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
  assert.equal(
    byName.domain.type,
    "string",
    "a member named 'domain' is a member, not a domain clause",
  );
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

test("real-world syntax: nested classes, body domains, parameter domains, flags, operators", () => {
  const bom = parseBom(
    `#loadGetterSetterAsProperties
property origin "xom:/P/xom"
package org.sample;

public class Contributor
        extends java.io.Serializable
{
    static public final class Role
            extends java.lang.Enum
    {
        domain {static Author, static Approver}
        public static final readonly org.sample.Contributor.Role Approver;
        public static final readonly org.sample.Contributor.Role Author;
    }
    public string fullname;
    public writeonly org.xml.sax.Locator documentLocator;
    public abstract string @package;
    public static java.util.List find(string arg1,
        java.util.List arg2 domain 0,* class org.sample.Contributor) domain 0,* class org.sample.Contributor;
    public static operator java.util.Date(org.sample.Contributor c);
    Contributor(string name);
}

class Year
    #valueType
    property alias "integer"
{
    public int value;
}
`,
    { project: "P", path: "bom/x.bom" },
    "x",
  );
  assert.deepEqual(bom.warnings, []);
  assert.equal(bom.properties["#loadGetterSetterAsProperties"], "true");
  assert.deepEqual(
    bom.classes.map((klass) => klass.fqn),
    ["org.sample.Contributor", "org.sample.Contributor.Role", "org.sample.Year"],
  );
  assert.deepEqual(bom.classes[1].domain, ["Author", "Approver"]);
  assert.equal(bom.classes[1].packageName, "org.sample");
  assert.equal(bom.classes[2].properties["#valueType"], "true");
  const ids = bom.members.map((member) => member.id);
  for (const id of [
    "org.sample.Contributor.Role.Approver",
    "org.sample.Contributor.Role.Author",
    "org.sample.Contributor.fullname",
    "org.sample.Contributor.documentLocator",
    "org.sample.Contributor.package",
    "org.sample.Contributor.find(string,java.util.List)",
    "org.sample.Contributor.operator java.util.Date(org.sample.Contributor)",
    "org.sample.Contributor.Contributor(string)",
    "org.sample.Year.value",
  ]) {
    assert.ok(ids.includes(id), `${id} in ${ids.join(", ")}`);
  }
});
