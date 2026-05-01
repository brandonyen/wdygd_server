import { getSupabase } from "../utils/get-supabase-client";

export const handler = async (event: any) => {
  console.log("Cognito Post Confirmation triggered:", JSON.stringify(event));

  if (event.triggerSource === "PostConfirmation_ConfirmSignUp") {
    const email = event.request.userAttributes.email;
    if (!email) {
      console.error("No email found in user attributes");
      return event;
    }

    try {
      const supabase = await getSupabase();

      // Insert if doesn't exist
      const { error } = await (supabase.from("UserConfig") as any).insert([
        {
          email,
          created_at: new Date().toISOString(),
          last_sync: new Date().toISOString(),
        },
      ]);

      if (error) {
        console.error("Error inserting user config:", error);
      } else {
        console.log(`Successfully created UserConfig for ${email}`);
      }
    } catch (err) {
      console.error("Unexpected error in Post Confirmation Lambda:", err);
    }
  }

  return event;
};
