"""Synthetic fixtures for the disposable CI site only; never run on an existing site."""
import json
import secrets
from pathlib import Path

import frappe
from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry


def run():
    assert frappe.local.site == "mcp.localhost"
    assert not frappe.db.exists("Company", "MCP Alpha"), "Requires a fresh CI site"
    frappe.db.set_single_value("System Settings", "time_zone", "UTC")
    frappe.db.set_single_value("System Settings", "currency_precision", 2)
    frappe.db.set_single_value("Accounts Settings", "acc_frozen_upto", None)
    from erpnext.setup.setup_wizard.operations.install_fixtures import install
    install("New Zealand")
    for currency in ("NZD", "USD"):
        frappe.db.set_value("Currency", currency, "enabled", 1)
        frappe.get_doc({"doctype": "Price List", "price_list_name": f"MCP {currency}",
            "currency": currency, "enabled": 1, "selling": 1, "buying": 1}).insert()
    frappe.get_doc({"doctype": "Fiscal Year", "year": "MCP 2025", "year_start_date": "2025-01-01", "year_end_date": "2025-12-31"}).insert()
    companies = {}
    for name, abbr in (("MCP Alpha", "MCPA"), ("MCP Hidden", "MCPH")):
        company = frappe.get_doc({"doctype": "Company", "company_name": name, "abbr": abbr,
            "default_currency": "NZD", "country": "New Zealand", "create_chart_of_accounts_based_on": "Standard Template", "chart_of_accounts": "Standard",
            "enable_perpetual_inventory": 0}).insert()
        company.reload()
        companies[name] = company
    for name in ("MCP Buyer", "MCP Future", "MCP Credit"):
        frappe.get_doc({"doctype": "Customer", "customer_name": name, "customer_type": "Company",
            "customer_group": "Commercial", "territory": "New Zealand"}).insert()
    frappe.get_doc({"doctype": "Supplier", "supplier_name": "MCP Supplier", "supplier_group": "Services", "supplier_type": "Company"}).insert()
    for code in ("MCP Service A", "MCP Service B"):
        frappe.get_doc({"doctype": "Item", "item_code": code, "item_name": code, "item_group": "Services",
            "stock_uom": "Nos", "is_stock_item": 0}).insert()

    def invoice(doctype, amount, *, company="MCP Alpha", party=None, currency="NZD", due="2025-01-20", draft=False, credit=False, split=False):
        co = companies[company]
        sales = doctype == "Sales Invoice"
        item = {"item_code": "MCP Service A", "qty": -1 if credit else 1, "rate": amount,
            "income_account": co.default_income_account, "expense_account": co.default_expense_account,
            "cost_center": co.cost_center}
        items = [item]
        if split:
            items = [{**item, "qty": 2, "rate": 30}, {**item, "item_code": "MCP Service B", "rate": 40}]
        doc = frappe.get_doc({"doctype": doctype, "company": company,
            "customer" if sales else "supplier": party or ("MCP Buyer" if sales else "MCP Supplier"),
            "posting_date": "2025-01-10", "set_posting_time": 1, "due_date": due,
            "currency": currency, "conversion_rate": 2 if currency == "USD" else 1,
            "selling_price_list" if sales else "buying_price_list": f"MCP {currency}",
            "price_list_currency": currency, "plc_conversion_rate": 2 if currency == "USD" else 1,
            "ignore_pricing_rule": 1,
            "debit_to" if sales else "credit_to": co.default_receivable_account if sales else co.default_payable_account,
            "is_return": int(credit), "update_stock": 0, "items": items,
            "taxes": [], "disable_rounded_total": 1})
        doc.insert()
        if not draft:
            doc.submit()
        return doc

    sales = invoice("Sales Invoice", 100, split=True)
    usd = invoice("Sales Invoice", 50, currency="USD", due="2025-01-31")
    future = invoice("Sales Invoice", 80, party="MCP Future", due="2025-02-10")
    credit = invoice("Sales Invoice", 20, party="MCP Credit", credit=True)
    draft = invoice("Sales Invoice", 900, draft=True)
    hidden = invoice("Sales Invoice", 777, company="MCP Hidden")
    purchase = invoice("Purchase Invoice", 60, due="2025-01-15")
    purchase_usd = invoice("Purchase Invoice", 25, currency="USD", due="2025-01-31")

    def pay(doc, amount):
        payment = get_payment_entry(doc.doctype, doc.name, party_amount=amount,
            bank_account=companies[doc.company].default_cash_account)
        payment.posting_date = "2025-01-15"
        payment.reference_date = "2025-01-15"
        payment.reference_no = "MCP FIXTURE"
        payment.insert()
        payment.submit()
        return payment

    received = pay(sales, 30)
    paid = pay(purchase, 10)
    credentials = {}
    # Item-wise Sales Register also needs UOM read access (Stock User).
    reader_roles = ["Accounts User", "Accounts Manager", "Stock User"]
    for role_name, roles in (("all", reader_roles), ("restricted", reader_roles), ("denied", [])):
        user = frappe.get_doc({"doctype": "User", "email": f"mcp-{role_name}@example.invalid",
            "first_name": f"MCP {role_name}", "enabled": 1, "user_type": "System User", "send_welcome_email": 0,
            "roles": [{"role": role} for role in roles], "api_key": secrets.token_hex(16), "api_secret": secrets.token_hex(16)}).insert()
        credentials[role_name] = {"user": user.name, "apiKey": user.api_key, "apiSecret": user.get_password("api_secret")}
        if role_name == "restricted":
            frappe.get_doc({"doctype": "User Permission", "user": user.name, "allow": "Company",
                "for_value": "MCP Alpha", "apply_to_all_doctypes": 1}).insert()
    frappe.db.commit()
    frappe.clear_cache()
    manifest = {"credentials": credentials, "sales": sales.name, "usd": usd.name, "future": future.name,
        "credit": credit.name, "draft": draft.name, "hidden": hidden.name, "purchase": purchase.name,
        "purchase_usd": purchase_usd.name, "received": received.name, "paid": paid.name,
        "receivable": companies["MCP Alpha"].default_receivable_account}
    output = Path(frappe.get_site_path("..", "live-fixtures.json")).resolve()
    output.write_text(json.dumps(manifest))
    output.chmod(0o600)
