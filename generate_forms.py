import json
import os

def replace_data_block(html, var_name, data):
    start_str = f"const {var_name} = {{"
    start_idx = html.find(start_str)
    if start_idx == -1:
        return html
    
    brace_count = 0
    end_idx = -1
    for i in range(start_idx + len(f"const {var_name} = "), len(html)):
        if html[i] == '{':
            brace_count += 1
        elif html[i] == '}':
            brace_count -= 1
            if brace_count == 0:
                end_idx = i + 1
                if i+1 < len(html) and html[i+1] == ';':
                    end_idx += 1
                break
                
    if end_idx != -1:
        data_js = json.dumps(data, indent=4)
        return html[:start_idx] + f"const {var_name} = {data_js};" + html[end_idx:]
    return html

with open('Business_Form_Template.html', 'r', encoding='utf-8') as f:
    template_content = f.read()

def generate_html(filename, mode, data):
    html = template_content
    # set mode
    html = html.replace("let currentMode = 'transaction';", f"let currentMode = '{mode}';")
    
    # replace dataset
    if mode == 'transaction':
        html = replace_data_block(html, 'transactionData', data)
    else:
        html = replace_data_block(html, 'masterData', data)
        
    # Update Title
    import re
    html = re.sub(r"<title>.*?</title>", f"<title>{data['badge']} - KompakApps</title>", html)
    
    # Hide the mode switcher buttons so it looks like a dedicated page
    html = html.replace('id="btnModeTx"', 'id="btnModeTx" style="display:none;"')
    html = html.replace('id="btnModeMaster"', 'id="btnModeMaster" style="display:none;"')
    
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(html)


master_forms = {
    "forms/master/Product_Master.html": {
        "code": "PROD-NEW",
        "badge": "Product Master",
        "breadcrumbCategory": "Master Data",
        "currentStageIndex": 2,
        "stages": ["Draft", "In Review", "Active", "Archived"],
        "linkedDocs": [
            { "label": "On Hand", "count": "0", "subtext": "Stock", "icon": "fa-boxes", "bg": "hover:bg-blue-50", "badgeColor": "text-blue-700 bg-blue-100" }
        ],
        "headerLeft": [
            { "id": "name", "label": "Product Name", "type": "text", "value": "" },
            { "id": "type", "label": "Product Type", "type": "select", "options": ["Storable Product", "Consumable", "Service"], "value": "Storable Product" },
            { "id": "category", "label": "Category", "type": "select", "options": ["All", "Raw Material", "Finished Goods"], "value": "All" },
            { "id": "barcode", "label": "Barcode", "type": "text", "value": "" }
        ],
        "headerRight": [
            { "id": "price", "label": "Sales Price", "type": "text", "value": "Rp 0" },
            { "id": "cost", "label": "Cost", "type": "text", "value": "Rp 0" },
            { "id": "uom", "label": "Unit of Measure", "type": "select", "options": ["Units", "Dozens", "Kg"], "value": "Units" },
            { "id": "sku", "label": "Internal Reference", "type": "text", "value": "" }
        ],
        "linesTitle": "Variants & Attributes",
        "lines": [],
        "terms": "Product internal notes...",
        "activities": []
    },
    "forms/master/Vendor_Master.html": {
        "code": "VENDOR-NEW",
        "badge": "Vendor Master",
        "breadcrumbCategory": "Purchase / Master",
        "currentStageIndex": 2,
        "stages": ["Draft", "Verified", "Active", "Archived"],
        "linkedDocs": [
            { "label": "Bills", "count": "0", "subtext": "Vendor Bills", "icon": "fa-receipt", "bg": "hover:bg-blue-50", "badgeColor": "text-blue-700 bg-blue-100" }
        ],
        "headerLeft": [
            { "id": "name", "label": "Vendor Name", "type": "text", "value": "" },
            { "id": "type", "label": "Company Type", "type": "select", "options": ["Company", "Individual"], "value": "Company" },
            { "id": "address", "label": "Address", "type": "text", "value": "" },
            { "id": "tax_id", "label": "Tax ID / NPWP", "type": "text", "value": "" }
        ],
        "headerRight": [
            { "id": "phone", "label": "Phone", "type": "tel", "value": "" },
            { "id": "email", "label": "Email", "type": "email", "value": "" },
            { "id": "website", "label": "Website", "type": "text", "value": "" },
            { "id": "payment_terms", "label": "Payment Terms", "type": "select", "options": ["Immediate Payment", "15 Days", "30 Days"], "value": "30 Days" }
        ],
        "linesTitle": "Contacts & Addresses",
        "lines": [],
        "terms": "Vendor notes...",
        "activities": []
    },
    "forms/master/Customer_Master.html": {
        "code": "CUST-NEW",
        "badge": "Customer Master",
        "breadcrumbCategory": "Sales / Master",
        "currentStageIndex": 2,
        "stages": ["Draft", "Verified", "Active", "Archived"],
        "linkedDocs": [
            { "label": "Sales", "count": "0", "subtext": "Sales Orders", "icon": "fa-chart-line", "bg": "hover:bg-blue-50", "badgeColor": "text-blue-700 bg-blue-100" }
        ],
        "headerLeft": [
            { "id": "name", "label": "Customer Name", "type": "text", "value": "" },
            { "id": "type", "label": "Company Type", "type": "select", "options": ["Company", "Individual"], "value": "Company" },
            { "id": "address", "label": "Address", "type": "text", "value": "" },
            { "id": "tax_id", "label": "Tax ID / NPWP", "type": "text", "value": "" }
        ],
        "headerRight": [
            { "id": "phone", "label": "Phone", "type": "tel", "value": "" },
            { "id": "email", "label": "Email", "type": "email", "value": "" },
            { "id": "website", "label": "Website", "type": "text", "value": "" },
            { "id": "credit_limit", "label": "Credit Limit", "type": "text", "value": "Rp 0" }
        ],
        "linesTitle": "Contacts & Addresses",
        "lines": [],
        "terms": "Customer notes...",
        "activities": []
    },
    "forms/master/Vendor_Pricelist.html": {
        "code": "VPRICE-NEW",
        "badge": "Vendor Pricelist",
        "breadcrumbCategory": "Purchase / Master",
        "currentStageIndex": 1,
        "stages": ["Draft", "Active", "Expired"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "vendor", "label": "Vendor", "type": "text", "value": "" },
            { "id": "product", "label": "Product", "type": "text", "value": "" }
        ],
        "headerRight": [
            { "id": "currency", "label": "Currency", "type": "select", "options": ["IDR", "USD"], "value": "IDR" },
            { "id": "price", "label": "Price", "type": "text", "value": "Rp 0" },
            { "id": "min_qty", "label": "Min. Quantity", "type": "number", "value": "1" }
        ],
        "linesTitle": "Validity Periods",
        "lines": [],
        "terms": "",
        "activities": []
    },
    "forms/master/Unit_of_Measurement.html": {
        "code": "UOM-NEW",
        "badge": "Unit of Measurement",
        "breadcrumbCategory": "Inventory / Master",
        "currentStageIndex": 1,
        "stages": ["Draft", "Active", "Archived"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "name", "label": "Unit of Measure", "type": "text", "value": "" },
            { "id": "category", "label": "Category", "type": "text", "value": "Unit" }
        ],
        "headerRight": [
            { "id": "type", "label": "Type", "type": "select", "options": ["Reference Unit", "Bigger than reference", "Smaller than reference"], "value": "Reference Unit" },
            { "id": "ratio", "label": "Ratio", "type": "text", "value": "1.0" }
        ],
        "linesTitle": "Details",
        "lines": [],
        "terms": "",
        "activities": []
    },
    "forms/master/Lot_Serial_Number.html": {
        "code": "LOT-NEW",
        "badge": "Lot & Serial Number",
        "breadcrumbCategory": "Inventory / Master",
        "currentStageIndex": 1,
        "stages": ["Draft", "Active", "Archived"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "lot", "label": "Lot/Serial Number", "type": "text", "value": "" },
            { "id": "product", "label": "Product", "type": "text", "value": "" }
        ],
        "headerRight": [
            { "id": "qty", "label": "Quantity", "type": "text", "value": "1.0" },
            { "id": "expiration", "label": "Expiration Date", "type": "date", "value": "" }
        ],
        "linesTitle": "Tracing",
        "lines": [],
        "terms": "",
        "activities": []
    },
    "forms/master/Warehouse_Location.html": {
        "code": "WH-NEW",
        "badge": "Warehouse & Location",
        "breadcrumbCategory": "Inventory / Master",
        "currentStageIndex": 1,
        "stages": ["Draft", "Active", "Archived"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "name", "label": "Warehouse Name", "type": "text", "value": "" },
            { "id": "short_name", "label": "Short Name", "type": "text", "value": "" }
        ],
        "headerRight": [
            { "id": "address", "label": "Address", "type": "text", "value": "" },
            { "id": "type", "label": "Location Type", "type": "select", "options": ["Internal Location", "View", "Customer Location", "Vendor Location", "Transit"], "value": "Internal Location" }
        ],
        "linesTitle": "Sub-locations",
        "lines": [],
        "terms": "",
        "activities": []
    },
    "forms/master/Bill_of_Material.html": {
        "code": "BOM-NEW",
        "badge": "Bill of Material",
        "breadcrumbCategory": "Manufacture / Master",
        "currentStageIndex": 1,
        "stages": ["Draft", "Active", "Archived"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "product", "label": "Product", "type": "text", "value": "" },
            { "id": "qty", "label": "Quantity", "type": "text", "value": "1.0" }
        ],
        "headerRight": [
            { "id": "bom_type", "label": "BOM Type", "type": "select", "options": ["Manufacture this product", "Kit"], "value": "Manufacture this product" },
            { "id": "company", "label": "Company", "type": "text", "value": "KompakApps" }
        ],
        "linesTitle": "Components",
        "lines": [
            { "id": 1, "name": "Component A", "qty": 2, "unit": "Unit", "price": 0, "customSub": "Raw Material" }
        ],
        "terms": "",
        "activities": []
    },
    "forms/master/WorkCenter.html": {
        "code": "WC-NEW",
        "badge": "WorkCenter",
        "breadcrumbCategory": "Manufacture / Master",
        "currentStageIndex": 1,
        "stages": ["Draft", "Active", "Archived"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "name", "label": "WorkCenter Name", "type": "text", "value": "" },
            { "id": "code", "label": "Code", "type": "text", "value": "" }
        ],
        "headerRight": [
            { "id": "working_hours", "label": "Working Hours", "type": "text", "value": "Standard 40 hours/week" },
            { "id": "cost", "label": "Cost per Hour", "type": "text", "value": "Rp 0" },
            { "id": "capacity", "label": "Capacity", "type": "text", "value": "1.0" }
        ],
        "linesTitle": "Equipment",
        "lines": [],
        "terms": "",
        "activities": []
    },
    "forms/master/POS_Station.html": {
        "code": "POS-NEW",
        "badge": "POS Station",
        "breadcrumbCategory": "POS / Master",
        "currentStageIndex": 1,
        "stages": ["Draft", "Active", "Archived"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "name", "label": "POS Name", "type": "text", "value": "" },
            { "id": "company", "label": "Company", "type": "text", "value": "KompakApps" }
        ],
        "headerRight": [
            { "id": "pricelist", "label": "Pricelist", "type": "text", "value": "Public Pricelist" },
            { "id": "receipt", "label": "Receipt Type", "type": "select", "options": ["Standard", "Custom Header"], "value": "Standard" }
        ],
        "linesTitle": "Payment Methods",
        "lines": [
            { "id": 1, "name": "Cash", "qty": 1, "unit": "-", "price": 0, "customSub": "Active" },
            { "id": 2, "name": "Credit Card", "qty": 1, "unit": "-", "price": 0, "customSub": "Active" }
        ],
        "terms": "",
        "activities": []
    },
    "forms/master/Promotion_Loyalty.html": {
        "code": "PROMO-NEW",
        "badge": "Promotion & Loyalty",
        "breadcrumbCategory": "Sales / Master",
        "currentStageIndex": 1,
        "stages": ["Draft", "Active", "Expired"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "name", "label": "Program Name", "type": "text", "value": "" },
            { "id": "type", "label": "Program Type", "type": "select", "options": ["Discount", "Buy 1 Get 1", "Loyalty Cards"], "value": "Discount" }
        ],
        "headerRight": [
            { "id": "start", "label": "Start Date", "type": "date", "value": "" },
            { "id": "end", "label": "End Date", "type": "date", "value": "" }
        ],
        "linesTitle": "Rules & Rewards",
        "lines": [],
        "terms": "",
        "activities": []
    },
    "forms/master/Pricelist.html": {
        "code": "PRICELIST-NEW",
        "badge": "Pricelist",
        "breadcrumbCategory": "Sales / Master",
        "currentStageIndex": 1,
        "stages": ["Draft", "Active", "Archived"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "name", "label": "Pricelist Name", "type": "text", "value": "" },
            { "id": "currency", "label": "Currency", "type": "select", "options": ["IDR", "USD"], "value": "IDR" }
        ],
        "headerRight": [
            { "id": "company", "label": "Company", "type": "text", "value": "KompakApps" }
        ],
        "linesTitle": "Pricelist Items",
        "lines": [],
        "terms": "",
        "activities": []
    }
}

transaction_forms = {
    "forms/transaction/Purchase_Request.html": {
        "code": "PR-2026-0001",
        "badge": "Purchase Request",
        "breadcrumbCategory": "Purchase",
        "currentStageIndex": 0,
        "stages": ["Draft", "Submitted", "Approved", "Done"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "requester", "label": "Requester", "type": "text", "value": "Admin Nusara" },
            { "id": "date", "label": "Request Date", "type": "date", "value": "2026-10-09" }
        ],
        "headerRight": [
            { "id": "approver", "label": "Approver", "type": "text", "value": "Manager" },
            { "id": "expected", "label": "Expected Date", "type": "date", "value": "2026-10-15" }
        ],
        "linesTitle": "Requested Items",
        "lines": [
            { "id": 1, "name": "Office Supplies", "qty": 10, "unit": "Box", "price": 50000 }
        ],
        "terms": "Please approve ASAP.",
        "activities": []
    },
    "forms/transaction/Purchase_Order.html": {
        "code": "PO-2026-0123",
        "badge": "Purchase Order",
        "breadcrumbCategory": "Purchase",
        "currentStageIndex": 1,
        "stages": ["RFQ", "RFQ Sent", "Purchase Order", "Done"],
        "linkedDocs": [
            { "label": "Receipts", "count": "0", "subtext": "Deliveries", "icon": "fa-truck", "bg": "hover:bg-blue-50", "badgeColor": "text-blue-700 bg-blue-100" }
        ],
        "headerLeft": [
            { "id": "vendor", "label": "Vendor", "type": "text", "value": "PT Supplier Maju" },
            { "id": "vendor_ref", "label": "Vendor Reference", "type": "text", "value": "" }
        ],
        "headerRight": [
            { "id": "date", "label": "Order Date", "type": "date", "value": "2026-10-09" },
            { "id": "payment_terms", "label": "Payment Terms", "type": "select", "options": ["Immediate", "15 Days", "30 Days"], "value": "30 Days" }
        ],
        "linesTitle": "Products",
        "lines": [
            { "id": 1, "name": "Raw Material A", "qty": 100, "unit": "Kg", "price": 12000 }
        ],
        "terms": "Delivery required before month end.",
        "activities": []
    },
    "forms/transaction/Vendor_Bill.html": {
        "code": "BILL-2026-0045",
        "badge": "Vendor Bill",
        "breadcrumbCategory": "Accounting",
        "currentStageIndex": 0,
        "stages": ["Draft", "Posted", "Paid"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "vendor", "label": "Vendor", "type": "text", "value": "PT Supplier Maju" },
            { "id": "bill_date", "label": "Bill Date", "type": "date", "value": "2026-10-09" }
        ],
        "headerRight": [
            { "id": "acct_date", "label": "Accounting Date", "type": "date", "value": "2026-10-09" },
            { "id": "journal", "label": "Journal", "type": "text", "value": "Vendor Bills" }
        ],
        "linesTitle": "Invoice Lines",
        "lines": [
            { "id": 1, "name": "Raw Material A", "qty": 100, "unit": "Kg", "price": 12000 }
        ],
        "terms": "",
        "activities": []
    },
    "forms/transaction/Inventory_Operation.html": {
        "code": "WH/IN/0001",
        "badge": "Inventory Operation (Receipt/Delivery)",
        "breadcrumbCategory": "Inventory",
        "currentStageIndex": 1,
        "stages": ["Draft", "Waiting", "Ready", "Done"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "partner", "label": "Partner", "type": "text", "value": "PT Supplier Maju" },
            { "id": "source", "label": "Source Document", "type": "text", "value": "PO-2026-0123" }
        ],
        "headerRight": [
            { "id": "scheduled", "label": "Scheduled Date", "type": "date", "value": "2026-10-10" },
            { "id": "src_loc", "label": "Source Location", "type": "text", "value": "Partner Locations/Vendors" },
            { "id": "dest_loc", "label": "Destination Location", "type": "text", "value": "WH/Stock" }
        ],
        "linesTitle": "Operations",
        "lines": [
            { "id": 1, "name": "Raw Material A", "qty": 100, "unit": "Kg", "price": 0 }
        ],
        "terms": "",
        "activities": []
    },
    "forms/transaction/Inventory_Adjustment.html": {
        "code": "INV-ADJ-001",
        "badge": "Inventory Adjustment",
        "breadcrumbCategory": "Inventory",
        "currentStageIndex": 0,
        "stages": ["Draft", "In Progress", "Validated"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "ref", "label": "Reference", "type": "text", "value": "Annual Physical Count" },
            { "id": "location", "label": "Location", "type": "text", "value": "WH/Stock" }
        ],
        "headerRight": [
            { "id": "date", "label": "Date", "type": "date", "value": "2026-10-09" }
        ],
        "linesTitle": "Inventory Lines",
        "lines": [
            { "id": 1, "name": "Product X", "qty": 50, "unit": "Unit", "price": 0 }
        ],
        "terms": "",
        "activities": []
    },
    "forms/transaction/Manufacturing_Order.html": {
        "code": "MO-2026-0005",
        "badge": "Manufacturing Order",
        "breadcrumbCategory": "Manufacture",
        "currentStageIndex": 1,
        "stages": ["Draft", "Confirmed", "In Progress", "Done"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "product", "label": "Product", "type": "text", "value": "Finished Good Y" },
            { "id": "bom", "label": "Bill of Material", "type": "text", "value": "BOM Finished Good Y" },
            { "id": "qty", "label": "Quantity to Produce", "type": "text", "value": "10 Unit" }
        ],
        "headerRight": [
            { "id": "date", "label": "Scheduled Date", "type": "date", "value": "2026-10-12" },
            { "id": "responsible", "label": "Responsible", "type": "text", "value": "Factory Manager" }
        ],
        "linesTitle": "Components to Consume",
        "lines": [
            { "id": 1, "name": "Component A", "qty": 20, "unit": "Unit", "price": 0 },
            { "id": 2, "name": "Component B", "qty": 10, "unit": "Kg", "price": 0 }
        ],
        "terms": "",
        "activities": []
    },
    "forms/transaction/Lead_Opportunity.html": {
        "code": "OPP-0010",
        "badge": "Opportunity",
        "breadcrumbCategory": "CRM",
        "currentStageIndex": 1,
        "stages": ["New", "Qualified", "Proposition", "Won"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "opp_name", "label": "Opportunity Name", "type": "text", "value": "Software Implementation" },
            { "id": "customer", "label": "Customer", "type": "text", "value": "PT XYZ Corp" },
            { "id": "revenue", "label": "Expected Revenue", "type": "text", "value": "Rp 50.000.000" }
        ],
        "headerRight": [
            { "id": "probability", "label": "Probability (%)", "type": "text", "value": "50%" },
            { "id": "closing", "label": "Expected Closing", "type": "date", "value": "2026-11-01" },
            { "id": "salesperson", "label": "Salesperson", "type": "text", "value": "Sales Team A" }
        ],
        "linesTitle": "Expected Products",
        "lines": [
            { "id": 1, "name": "ERP License", "qty": 1, "unit": "Unit", "price": 50000000 }
        ],
        "terms": "",
        "activities": []
    },
    "forms/transaction/POS_Session.html": {
        "code": "POS/2026/001",
        "badge": "POS Session",
        "breadcrumbCategory": "POS",
        "currentStageIndex": 1,
        "stages": ["Opening Control", "In Progress", "Closing Control", "Closed"],
        "linkedDocs": [
            { "label": "Orders", "count": "15", "subtext": "POS Orders", "icon": "fa-receipt", "bg": "hover:bg-blue-50", "badgeColor": "text-blue-700 bg-blue-100" }
        ],
        "headerLeft": [
            { "id": "pos", "label": "Point of Sale", "type": "text", "value": "Main Cashier" },
            { "id": "responsible", "label": "Responsible", "type": "text", "value": "Cashier A" }
        ],
        "headerRight": [
            { "id": "opened", "label": "Opened Date", "type": "text", "value": "2026-10-09 08:00:00" },
            { "id": "start_bal", "label": "Starting Balance", "type": "text", "value": "Rp 1.000.000" }
        ],
        "linesTitle": "Summary",
        "lines": [
            { "id": 1, "name": "Cash Transactions", "qty": 1, "unit": "-", "price": 5500000 }
        ],
        "terms": "",
        "activities": []
    },
    "forms/transaction/Customer_Invoice.html": {
        "code": "INV-2026-0091",
        "badge": "Customer Invoice",
        "breadcrumbCategory": "Accounting",
        "currentStageIndex": 1,
        "stages": ["Draft", "Posted", "Paid"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "customer", "label": "Customer", "type": "text", "value": "PT XYZ Corp" },
            { "id": "inv_date", "label": "Invoice Date", "type": "date", "value": "2026-10-09" }
        ],
        "headerRight": [
            { "id": "due_date", "label": "Due Date", "type": "date", "value": "2026-11-09" },
            { "id": "terms", "label": "Payment Terms", "type": "select", "options": ["Immediate", "15 Days", "30 Days"], "value": "30 Days" }
        ],
        "linesTitle": "Invoice Lines",
        "lines": [
            { "id": 1, "name": "Consulting Service", "qty": 10, "unit": "Hours", "price": 500000 }
        ],
        "terms": "",
        "activities": []
    },
    "forms/transaction/Payment.html": {
        "code": "PAY-2026-0030",
        "badge": "Payment",
        "breadcrumbCategory": "Accounting",
        "currentStageIndex": 1,
        "stages": ["Draft", "Posted"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "type", "label": "Payment Type", "type": "select", "options": ["Send Money", "Receive Money"], "value": "Receive Money" },
            { "id": "partner", "label": "Customer / Vendor", "type": "text", "value": "PT XYZ Corp" },
            { "id": "amount", "label": "Amount", "type": "text", "value": "Rp 5.000.000" }
        ],
        "headerRight": [
            { "id": "date", "label": "Date", "type": "date", "value": "2026-10-09" },
            { "id": "journal", "label": "Journal", "type": "select", "options": ["Bank", "Cash"], "value": "Bank" },
            { "id": "method", "label": "Payment Method", "type": "text", "value": "Manual" }
        ],
        "linesTitle": "Payment Matching",
        "lines": [
            { "id": 1, "name": "INV-2026-0091", "qty": 1, "unit": "-", "price": 5000000 }
        ],
        "terms": "",
        "activities": []
    },
    "forms/transaction/Journal_Entry.html": {
        "code": "BNK/2026/10/001",
        "badge": "Journal Entry",
        "breadcrumbCategory": "Accounting",
        "currentStageIndex": 0,
        "stages": ["Draft", "Posted"],
        "linkedDocs": [],
        "headerLeft": [
            { "id": "ref", "label": "Reference", "type": "text", "value": "Bank Fees" },
            { "id": "journal", "label": "Journal", "type": "text", "value": "Bank" }
        ],
        "headerRight": [
            { "id": "date", "label": "Date", "type": "date", "value": "2026-10-09" }
        ],
        "linesTitle": "Journal Items",
        "lines": [
            { "id": 1, "name": "Bank Fees Expense (Debit)", "qty": 1, "unit": "-", "price": 25000 },
            { "id": 2, "name": "Bank Account (Credit)", "qty": 1, "unit": "-", "price": -25000 }
        ],
        "terms": "",
        "activities": []
    }
}

for fname, data in master_forms.items():
    generate_html(fname, 'master', data)

for fname, data in transaction_forms.items():
    generate_html(fname, 'transaction', data)

print("Generated forms successfully!")
