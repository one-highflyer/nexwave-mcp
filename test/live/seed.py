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
    frappe.db.set_single_value("Accounts Settings", "allow_stale", 1)
    # All exchange rates are synthetic local records. A missing rate must never call a provider.
    frappe.db.set_single_value("Currency Exchange Settings", "disabled", 1)
    from erpnext.setup.setup_wizard.operations.install_fixtures import install
    install("New Zealand")
    for currency in ("NZD", "USD"):
        frappe.db.set_value("Currency", currency, "enabled", 1)
        frappe.get_doc({"doctype": "Price List", "price_list_name": f"MCP {currency}",
            "currency": currency, "enabled": 1, "selling": 1, "buying": 1}).insert()
    frappe.get_doc({"doctype": "Currency Exchange", "date": "2025-01-01",
        "from_currency": "USD", "to_currency": "NZD", "exchange_rate": 2,
        "for_selling": 1, "for_buying": 1}).insert()
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

    # Quotation fixtures are separate from accounting fixtures so changing quote prices cannot
    # change the fixed invoice and ledger expectations above.
    quote_items = ("MCP Quote Service A", "MCP Quote Service B")
    for code in quote_items:
        frappe.get_doc({"doctype": "Item", "item_code": code, "item_name": code,
            "item_group": "Services", "stock_uom": "Nos", "is_stock_item": 0}).insert()
    quote_prices = []
    for code, rate in zip(quote_items, (25, 40)):
        price = frappe.get_doc({"doctype": "Item Price", "item_code": code,
            "price_list": "MCP NZD", "uom": "Nos", "price_list_rate": rate,
            "valid_from": "2025-01-01", "valid_upto": None}).insert()
        quote_prices.append(price.name)
    # Open-ended start and end dates must remain valid in the MCP date filter.
    frappe.db.set_value("Item Price", quote_prices[1], "valid_from", None)
    customer_price = frappe.get_doc({"doctype": "Item Price", "item_code": quote_items[0],
        "price_list": "MCP NZD", "uom": "Nos", "customer": "MCP Buyer", "price_list_rate": 20,
        "valid_from": "2025-01-01", "valid_upto": "2025-12-31"}).insert()
    supplier_price = frappe.get_doc({"doctype": "Item Price", "item_code": quote_items[0],
        "price_list": "MCP NZD", "uom": "Nos", "supplier": "MCP Supplier", "price_list_rate": 10,
        "valid_from": "2025-01-01", "valid_upto": "2025-12-31"}).insert()
    expired_price = frappe.get_doc({"doctype": "Item Price", "item_code": quote_items[0],
        "price_list": "MCP USD", "uom": "Nos", "price_list_rate": 1,
        "valid_from": "2024-01-01", "valid_upto": "2024-12-31"}).insert()
    usd_quote_prices = []
    for code, rate in zip(quote_items, (12, 18)):
        price = frappe.get_doc({"doctype": "Item Price", "item_code": code,
            "price_list": "MCP USD", "uom": "Nos", "price_list_rate": rate,
            "valid_from": "2025-01-01", "valid_upto": None}).insert()
        usd_quote_prices.append(price.name)
    pricing_rule = frappe.get_doc({"doctype": "Pricing Rule", "title": "MCP Quantity Discount",
        "apply_on": "Item Code", "items": [{"item_code": quote_items[0]}],
        "price_or_product_discount": "Price", "selling": 1, "buying": 0,
        "currency": "NZD", "company": "MCP Alpha", "for_price_list": "MCP NZD",
        "valid_from": "2025-01-01", "valid_upto": "2025-12-31", "min_qty": 10,
        "rate_or_discount": "Discount Percentage", "discount_percentage": 10}).insert()
    lead = frappe.get_doc({"doctype": "Lead", "first_name": "MCP", "last_name": "Seed Prospect",
        "company_name": "MCP Prospect Company", "email_id": "mcp-seed-prospect@example.invalid",
        "company": "MCP Alpha"}).insert()
    alpha = companies["MCP Alpha"]
    tax_account = frappe.get_doc({"doctype": "Account", "account_name": "MCP Output Tax",
        "company": alpha.name, "parent_account": frappe.db.get_value("Account", alpha.default_payable_account, "parent_account"),
        "account_type": "Tax", "account_currency": "NZD", "is_group": 0}).insert()
    sales_templates = []
    for title, rate in (("MCP Sales Tax 15", 15), ("MCP Sales Tax 5", 5)):
        template = frappe.get_doc({"doctype": "Sales Taxes and Charges Template", "title": title,
            "company": alpha.name, "is_default": 0,
            "taxes": [{"charge_type": "On Net Total", "account_head": tax_account.name,
                "description": title, "rate": rate, "cost_center": alpha.cost_center}]}).insert()
        sales_templates.append(template.name)
    purchase_template = frappe.get_doc({"doctype": "Purchase Taxes and Charges Template",
        "title": "MCP Purchase Tax", "company": alpha.name, "is_default": 0,
        "taxes": [{"charge_type": "On Net Total", "account_head": tax_account.name,
            "description": "MCP Purchase Tax", "rate": 15, "cost_center": alpha.cost_center,
            "category": "Total", "add_deduct_tax": "Add"}]}).insert()
    terms = frappe.get_doc({"doctype": "Terms and Conditions", "title": "MCP Quote Terms",
        "selling": 1, "buying": 0, "terms": "Synthetic quotation terms for CI."}).insert()
    payment_terms = frappe.get_doc({"doctype": "Payment Terms Template", "template_name": "MCP Seven Days",
        "terms": [{"invoice_portion": 100, "due_date_based_on": "Day(s) after invoice date", "credit_days": 7}]}).insert()
    quote_contacts = []
    quote_addresses = []
    for index, label in enumerate(("Primary", "Alternate")):
        contact = frappe.get_doc({"doctype": "Contact", "first_name": f"MCP {label}",
            "is_primary_contact": int(index == 0),
            "email_ids": [{"email_id": "mcp-primary@example.invalid", "is_primary": 1}] if index == 0 else [],
            "phone_nos": [{"phone": f"+1000000000{index + 1}", "is_primary_mobile_no": 1}],
            "links": [{"link_doctype": "Customer", "link_name": "MCP Future"}]}).insert()
        address = frappe.get_doc({"doctype": "Address", "address_title": f"MCP Future {label}",
            "address_type": "Billing", "address_line1": f"{index + 1} Synthetic Street", "city": "Auckland",
            "country": "New Zealand", "is_primary_address": int(index == 0), "is_shipping_address": int(index == 0),
            "links": [{"link_doctype": "Customer", "link_name": "MCP Future"}]}).insert()
        quote_contacts.append(contact.name)
        quote_addresses.append(address.name)
    frappe.db.set_value("Customer", "MCP Future", "customer_primary_contact", quote_contacts[0])

    # Source rows deliberately repeat one Item. Linking by item_code instead of the
    # exact child name would choose the wrong source line in the write tests.
    source_quotation = frappe.get_doc({"doctype": "Quotation", "company": alpha.name,
        "quotation_to": "Customer", "party_name": "MCP Buyer",
        "transaction_date": "2025-01-10", "valid_till": "2099-12-31",
        "currency": "NZD", "selling_price_list": "MCP NZD", "ignore_pricing_rule": 1,
        "items": [{"item_code": quote_items[1], "qty": 6, "uom": "Nos", "rate": 40},
            {"item_code": quote_items[1], "qty": 9, "uom": "Nos", "rate": 45}]}).insert()
    source_quotation.submit()
    source_purchase_order = frappe.get_doc({"doctype": "Purchase Order", "company": alpha.name,
        "supplier": "MCP Supplier", "transaction_date": "2025-01-10", "schedule_date": "2025-01-20",
        "currency": "NZD", "buying_price_list": "MCP NZD", "ignore_pricing_rule": 1,
        "items": [{"item_code": quote_items[1], "qty": 5, "uom": "Nos", "rate": 17,
                "schedule_date": "2025-01-20", "expense_account": alpha.default_expense_account,
                "cost_center": alpha.cost_center},
            {"item_code": quote_items[1], "qty": 8, "uom": "Nos", "rate": 22,
                "schedule_date": "2025-01-20", "expense_account": alpha.default_expense_account,
                "cost_center": alpha.cost_center}]}).insert()
    source_purchase_order.submit()
    credentials = {}
    # Item-wise Sales Register also needs UOM read access (Stock User).
    # Master roles grant Item Price reads and party creation. Gateway capabilities are tested
    # separately from these Frappe role permissions, including a fully read-only connection.
    reader_roles = ["Accounts User", "Accounts Manager", "Stock User", "Sales User",
        "Sales Master Manager", "Purchase User", "Purchase Master Manager"]
    for role_name, roles in (("all", reader_roles), ("restricted", reader_roles), ("readonly", reader_roles), ("denied", [])):
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
        "receivable": companies["MCP Alpha"].default_receivable_account,
        "quote_items": list(quote_items), "quote_prices": quote_prices,
        "usd_quote_prices": usd_quote_prices, "pricing_rule": pricing_rule.name,
        "customer_price": customer_price.name, "supplier_price": supplier_price.name,
        "expired_price": expired_price.name, "lead": lead.name,
        "sales_tax": sales_templates[0], "alternate_sales_tax": sales_templates[1],
        "purchase_tax": purchase_template.name, "terms": terms.name, "payment_terms": payment_terms.name,
        "quote_contacts": quote_contacts, "quote_addresses": quote_addresses,
        "source_quotation": source_quotation.name,
        "source_quotation_rows": [row.name for row in source_quotation.items],
        "source_purchase_order": source_purchase_order.name,
        "source_purchase_order_rows": [row.name for row in source_purchase_order.items]}
    output = Path(frappe.get_site_path("..", "live-fixtures.json")).resolve()
    output.write_text(json.dumps(manifest))
    output.chmod(0o600)
