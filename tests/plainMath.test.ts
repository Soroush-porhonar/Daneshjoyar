import { describe, expect, it } from "vitest";
import { latexToUnicode, plainMath } from "../src/rag/plainMath.js";

const hat = "\u0302";
const bar = "\u0304";

describe("plainMath", () => {
  it("turns the formulas of a real answer into Unicode", () => {
    expect(plainMath("با فرمول $1/n \\sum |y_i - \\hat{y}_i|$ محاسبه می‌شود [1].")).toBe(
      `با فرمول 1/n Σ |yᵢ - y${hat}ᵢ| محاسبه می‌شود [1].`,
    );
    expect(plainMath("$\\sqrt{1/n \\sum (y_i - \\hat{y}_i)^2}$")).toBe(`√(1/n Σ (yᵢ - y${hat}ᵢ)²)`);
    expect(plainMath("$1 - \\frac{\\sum(y_i - \\hat{y}_i)^2}{\\sum(y_i - \\bar{y}_i)^2}$")).toBe(
      `1 - (Σ(yᵢ - y${hat}ᵢ)²)/(Σ(yᵢ - y${bar}ᵢ)²)`,
    );
  });

  it("handles display math and the \\( \\) and \\[ \\] delimiters", () => {
    expect(plainMath("$$\\frac{100}{N} \\sum_{i=1}^{N} x_i$$")).toBe("100/N Σᵢ₌₁^N xᵢ");
    expect(plainMath("\\(a \\leq b\\) و \\[\\alpha \\times \\beta\\]")).toBe("a ≤ b و α × β");
  });

  it("keeps simple fractions and roots readable", () => {
    expect(latexToUnicode("\\frac{1}{n}")).toBe("1/n");
    expect(latexToUnicode("\\frac{a+b}{2}")).toBe("(a+b)/2");
    expect(latexToUnicode("\\sqrt{x}")).toBe("√x");
    expect(latexToUnicode("\\sqrt[3]{x+1}")).toBe("³√(x+1)");
    expect(latexToUnicode("x^{n+1}")).toBe("xⁿ⁺¹");
    expect(latexToUnicode("e^{-\\lambda t}")).toBe("e^(-λ t)");
    expect(latexToUnicode("\\text{MSE} = \\frac{1}{N}")).toBe("MSE = 1/N");
    expect(latexToUnicode("\\hat y - \\bar{x}")).toBe(`y${hat} - x${bar}`);
  });

  it("leaves text without delimited math alone: names, code-like words, prices", () => {
    const text = "متغیر file_name و a^b در متن، و قیمت $5 تا $10";
    expect(plainMath(text)).toBe(text);
  });

  it("never touches code blocks or inline code", () => {
    const text = "```python\nprint(f\"${x}_i\")\n```\nو `$a_i$` ولی $x_i$";
    expect(plainMath(text)).toBe("```python\nprint(f\"${x}_i\")\n```\nو `$a_i$` ولی xᵢ");
  });

  it("an unknown command keeps its argument; a bare unknown command stays as written", () => {
    expect(latexToUnicode("\\mathfrak{g}")).toBe("g");
    expect(latexToUnicode("\\binom{n}{k}")).toBe("C(n, k)");
    expect(latexToUnicode("a \\star b")).toBe("a \\star b");
  });
});
